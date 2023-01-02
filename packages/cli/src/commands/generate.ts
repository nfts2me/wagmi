import { getAddress } from '@ethersproject/address'
import type { Address } from 'abitype'
import { Abi as AbiSchema } from 'abitype/zod'
import { camelCase } from 'change-case'
import type { FSWatcher, WatchOptions } from 'chokidar'
import { watch } from 'chokidar'
import { default as dedent } from 'dedent'
import { default as fse } from 'fs-extra'
import { z } from 'zod'

import { version as packageVersion } from '../../package.json'
import type { Config, Contract, ContractConfig, Plugin, Watch } from '../config'
import { fromZodError } from '../errors'
import * as logger from '../logger'
import {
  findConfig,
  format,
  getAddressDocString,
  getIsUsingTypeScript,
  resolveConfig,
} from '../utils'

const Generate = z.object({
  /** Path to config file */
  config: z.string().optional(),
  /** Directory to search for config file */
  root: z.string().optional(),
  /** Watch for file system changes to config and plugins */
  watch: z.boolean().optional(),
})
export type Generate = z.infer<typeof Generate>

export async function generate(options: Generate) {
  logger.log('Generating code…')
  // Validate command line options
  try {
    await Generate.parseAsync(options)
  } catch (error) {
    if (error instanceof z.ZodError)
      throw fromZodError(error, { prefix: 'Invalid option' })
    throw error
  }

  // Get cli config file
  const configPath = await findConfig(options)
  if (!configPath) throw new Error(`Config not found at "${configPath}"`)
  const resolvedConfigs = await resolveConfig({ configPath })
  const isTypeScript = await getIsUsingTypeScript()

  const delay = 100
  const watchers: FSWatcher[] = []
  const watchOptions: WatchOptions = {
    atomic: true,
    // awaitWriteFinish: true,
    ignoreInitial: true,
    persistent: true,
  }

  const outNames = new Set<string>()
  const configs = Array.isArray(resolvedConfigs)
    ? resolvedConfigs
    : [resolvedConfigs]
  for (const config of configs) {
    if (outNames.has(config.out))
      throw new Error(`out "${config.out}" is not unique.`)
    outNames.add(config.out)
    logger.log(`Config "${config.out}"`)

    // Collect contracts and watch configs from plugins
    const { contractConfigs, plugins, watchConfigs } = await validatePlugins({
      config: config,
    })

    // Get contracts from config
    const contractNames = new Set<string>()
    const contractMap = new Map<string, Contract>()
    for (const contractConfig of contractConfigs) {
      if (contractNames.has(contractConfig.name))
        throw new Error(`Contract name "${contractConfig.name}" is not unique.`)
      logger.log(`Resolving contract "${contractConfig.name}"`)
      const contract = await getContract({ ...contractConfig, isTypeScript })
      contractMap.set(contract.name, contract)
    }

    // Run plugins
    const contracts = [...contractMap.values()]
    const result = await executePlugins({
      plugins,
      contracts,
      isTypeScript,
    })

    // Write output to file
    logger.log(`Saving to "${config.out}"`)
    await writeContracts({
      content: result.content,
      contracts,
      imports: result.imports,
      prepend: result.prepend,
      filename: config.out,
    })
    logger.log(`Saved to "${config.out}"`)

    if (options.watch) {
      if (!watchConfigs.length) {
        logger.log('Used --watch flag, but no plugins are watching.')
        continue
      }

      // Watch for changes
      let timeout: NodeJS.Timeout | null
      for (const watchConfig of watchConfigs) {
        const paths =
          typeof watchConfig.paths === 'function'
            ? await watchConfig.paths()
            : watchConfig.paths
        const watcher = watch(paths, watchOptions)
        // Watch for changes to files, new files, and deleted files
        watcher.on('all', async (event, path) => {
          if (event !== 'change' && event !== 'add' && event !== 'unlink')
            return
          let needsWrite = false
          if (event === 'change' || event === 'add') {
            const eventFn =
              event === 'change' ? watchConfig.onChange : watchConfig.onAdd
            const config = await eventFn?.(path)
            if (!config) return
            logger.log(`Resolving contract "${config.name}"`)
            const contract = await getContract({ ...config, isTypeScript })
            contractMap.set(contract.name, contract)
            needsWrite = true
          } else if (event === 'unlink') {
            const name = await watchConfig.onRemove?.(path)
            if (!name) return
            contractMap.delete(name)
            needsWrite = true
          }

          // Debounce writes
          if (needsWrite) {
            if (timeout) clearTimeout(timeout)
            timeout = setTimeout(async () => {
              timeout = null
              const contracts = [...contractMap.values()]
              const result = await executePlugins({
                plugins,
                contracts,
                isTypeScript,
              })
              await writeContracts({
                content: result.content,
                contracts,
                imports: result.imports,
                prepend: result.prepend,
                filename: config.out,
              })
              logger.log('Saved!')
            }, delay)
            needsWrite = false
          }
        })

        // Run parallel command on ready
        if (watchConfig.command)
          watcher.on('ready', async () => {
            await watchConfig?.command?.()
          })

        watchers.push(watcher)
      }
    }
  }

  if (!watchers.length) return

  // Watch `@wagmi/cli` config file for changes
  const watcher = watch(configPath).on('change', async (path) => {
    const { basename } = await import('pathe')
    logger.log(
      `> Found a change in ${basename(
        path,
      )}. Restart process for changes to take effect.`,
    )
  })
  watchers.push(watcher)

  // Display message and close watchers on exit
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  async function shutdown() {
    logger.log('Shutting down watch…')
    for (const watcher of watchers) {
      await watcher.close()
    }
  }
}

async function getContract({
  abi,
  address,
  name,
  isTypeScript,
}: ContractConfig & { isTypeScript: boolean }): Promise<Contract> {
  const constAssertion = isTypeScript ? ' as const' : ''
  const abiName = `${camelCase(name)}ABI`
  try {
    abi = await AbiSchema.parseAsync(abi)
  } catch (error) {
    if (error instanceof z.ZodError)
      throw fromZodError(error, { prefix: 'Invalid ABI' })
    throw error
  }
  const docString =
    typeof address === 'object'
      ? dedent`\n
      /**
       * ${getAddressDocString({ address })}
       */
    `
      : ''
  let content = dedent`
    ${getBannerContent({ name })}

    ${docString}
    export const ${abiName} = ${JSON.stringify(abi)}${constAssertion}
  `

  let meta: Contract['meta'] = { abiName }
  if (address) {
    let resolvedAddress
    try {
      const Address = z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, { message: 'Invalid address' })
        .transform((val) => getAddress(val)) as z.ZodType<Address>
      const MultiChainAddress = z.record(
        z.string().transform((val) => parseInt(val)),
        Address,
      )
      const AddressSchema = z.union([Address, MultiChainAddress])
      resolvedAddress = await AddressSchema.parseAsync(address)
    } catch (error) {
      if (error instanceof z.ZodError)
        throw fromZodError(error, { prefix: 'Invalid address' })
      throw error
    }

    const addressName = `${camelCase(name)}Address`
    const configName = `${camelCase(name)}Config`
    meta = {
      ...meta,
      addressName,
      configName,
    }

    const addressContent =
      typeof resolvedAddress === 'string'
        ? JSON.stringify(resolvedAddress)
        : // Remove quotes from chain id key
          JSON.stringify(resolvedAddress, null, 2).replace(
            /^\s*"(\d)":/gm,
            '$1:',
          )
    content = dedent`
      ${content}

      ${docString}
      export const ${addressName} = ${addressContent}${constAssertion}

      ${docString}
      export const ${configName} = { address: ${addressName}, abi: ${abiName} }${constAssertion}
    `
  }

  return { abi, address, content, meta, name }
}

async function writeContracts({
  content,
  contracts,
  imports,
  prepend,
  filename,
}: {
  content: string[]
  contracts: Contract[]
  imports: string[]
  prepend: string[]
  filename: string
}) {
  // Assemble code
  let code = dedent`
    // Generated by @wagmi/cli@${packageVersion} on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}
    ${imports.join('\n\n') ?? ''}

    ${prepend.join('\n\n') ?? ''}
  `
  for (const contract of contracts) {
    code = dedent`
      ${code}

      ${contract.content}
    `
  }
  code = dedent`
    ${code}
    
    ${content.join('\n\n') ?? ''}
  `

  // Format and write output
  const cwd = process.cwd()
  const outPath = `${cwd}/${filename}`
  const formatted = await format(code)
  await fse.writeFile(outPath, formatted)
}

async function executePlugins(config: {
  contracts: Contract[]
  isTypeScript: boolean
  plugins: Plugin[]
}) {
  const imports = []
  const prepend = []
  const content = []
  for (const plugin of config.plugins) {
    if (!plugin.run) continue
    logger.log(`Running plugin "${plugin.name}"`)
    const result = await plugin.run({
      contracts: config.contracts,
      isTypeScript: config.isTypeScript,
    })
    if (!result.imports && !result.prepend && !result.content) continue
    content.push(getBannerContent({ name: plugin.name }))
    result.imports && imports.push(result.imports)
    content.push(result.content)
    result.prepend && prepend.push(result.prepend)
  }
  return { content, imports, prepend } as const
}

async function validatePlugins({ config }: { config: Config }) {
  const contractConfigs = config.contracts ?? []
  const watchConfigs: Watch[] = []
  const plugins = config.plugins ?? []
  for (const plugin of plugins) {
    logger.log(`Validating plugin "${plugin.name}"`)
    await plugin.validate?.()
    if (plugin.watch) watchConfigs.push(plugin.watch)
    if (plugin.contracts) {
      logger.log(`Getting contracts for plugin "${plugin.name}"`)
      const contracts = await plugin.contracts()
      contractConfigs.push(...contracts)
      logger.log(
        `Found ${contracts.length} ${
          contracts.length === 1 ? 'contract' : 'contracts'
        }`,
      )
    }
  }
  return {
    contractConfigs,
    plugins,
    watchConfigs,
  }
}

function getBannerContent({ name }: { name: string }) {
  return dedent`
  ////////////////////////////////////////////////////////////////////////////
  // ${name}
  ////////////////////////////////////////////////////////////////////////////
  `
}
