import dedent from 'dedent'
import { execa } from 'execa'
import { default as fse } from 'fs-extra'
import { globby } from 'globby'
import { basename, extname, resolve } from 'pathe'

import type { Plugin } from '../config'
import * as logger from '../logger'
import type { RequiredBy } from '../types'

import {
  getInstallCommand,
  getIsPackageInstalled,
  getPackageManager,
} from '../utils'

const defaultExcludes = ['build-info/**', '*.dbg.json']

type HardhatConfig = {
  /**
   * Project's artifacts directory.
   *
   * Same as your project's `artifacts` [path configuration](https://hardhat.org/hardhat-runner/docs/config#path-configuration) option.
   *
   * @default 'artifacts/'
   */
  artifacts?: string
  /** Artifact files to exclude. */
  exclude?: string[]
  /** Commands to run */
  commands?: {
    /**
     * Remove build artifacts and cache directories on start up.
     *
     * @default `${packageManger} hardhat clean`
     */
    clean?: string | boolean
    /**
     * Build Hardhat project before fetching artifacts.
     *
     * @default `${packageManger} hardhat compile`
     */
    build?: string | boolean
    /**
     * Command to run when watched file or directory is changed.
     *
     * @default `${packageManger} hardhat compile`
     */
    rebuild?: string | boolean
  }
  /** Artifact files to include. */
  include?: string[]
  /** Optional prefix to prepend to artifact names. */
  namePrefix?: string
  /** Path to Hardhat project. */
  project: string
  /**
   * Project's artifacts directory.
   *
   * Same as your project's `sources` [path configuration](https://hardhat.org/hardhat-runner/docs/config#path-configuration) option.
   *
   * @default 'contracts/'
   */
  sources?: string
}

type HardhatResult = RequiredBy<Plugin, 'contracts' | 'validate' | 'watch'>

/**
 * Resolves ABIs from [Hardhat](https://github.com/NomicFoundation/hardhat) project.
 */
export function hardhat({
  artifacts = 'artifacts',
  exclude = defaultExcludes,
  commands = {},
  include = ['*.json'],
  namePrefix = '',
  project,
  sources = 'contracts',
}: HardhatConfig): HardhatResult {
  function getContractName(artifact: { contractName: string }) {
    return `${namePrefix}${artifact.contractName}`
  }

  async function getContract(artifactPath: string) {
    const artifact = await fse.readJSON(artifactPath)
    return {
      abi: artifact.abi,
      name: getContractName(artifact),
    }
  }

  async function getArtifactPaths(artifactsDirectory: string) {
    return await globby([
      ...include.map((x) => `${artifactsDirectory}/**/${x}`),
      ...exclude.map((x) => `!${artifactsDirectory}/**/${x}`),
    ])
  }

  const artifactsDirectory = `${project}/${artifacts}`
  const sourcesDirectory = `${project}/${sources}`

  const { build = true, clean = false, rebuild = true } = commands
  return {
    async contracts() {
      if (clean) {
        const packageManager = await getPackageManager()
        const [command, ...options] = (
          typeof clean === 'boolean' ? `${packageManager} hardhat clean` : clean
        ).split(' ')
        await execa(command!, options, { cwd: resolve(project) })
      }
      if (build) {
        const packageManager = await getPackageManager()
        const [command, ...options] = (
          typeof build === 'boolean'
            ? `${packageManager} hardhat compile`
            : build
        ).split(' ')
        await execa(command!, options, { cwd: resolve(project) })
      }
      if (!fse.pathExistsSync(artifactsDirectory))
        throw new Error('Artifacts not found.')

      const artifactPaths = await getArtifactPaths(artifactsDirectory)
      const contracts = []
      for (const artifactPath of artifactPaths) {
        const contract = await getContract(artifactPath)
        if (!contract.abi?.length) continue
        contracts.push(contract)
      }
      return contracts
    },
    name: 'Hardhat',
    async validate() {
      // Check that project directory exists
      if (!(await fse.pathExists(project)))
        throw new Error(`Project "${project}" not found.`)

      // Check that `hardhat` is installed
      const packageName = 'hardhat'
      const isPackageInstalled = await getIsPackageInstalled({
        packageName,
        cwd: project,
      })
      if (isPackageInstalled) return
      const [packageManager, command] = await getInstallCommand(packageName)
      throw new Error(dedent`
        ${packageName} must be installed to use Hardhat plugin.
        To install, run: ${packageManager} ${command.join(' ')}
      `)
    },
    watch: {
      command: rebuild
        ? async () => {
            logger.log(`Watching Hardhat project for changes at "${project}".`)
            const { watch } = await import('chokidar')
            const watcher = watch(sourcesDirectory, {
              atomic: true,
              awaitWriteFinish: true,
              ignoreInitial: true,
              persistent: true,
            })
            const [command, ...options] = (
              typeof rebuild === 'boolean'
                ? `${await getPackageManager()} hardhat compile`
                : rebuild
            ).split(' ')
            watcher.on('all', async (event) => {
              if (event !== 'change' && event !== 'add' && event !== 'unlink')
                return
              await execa(command!, options, {
                cwd: resolve(project),
              }).stdout?.on('data', (data) => {
                process.stdout.write(`Hardhat: ${data}`)
              })
            })
            process.once('SIGINT', shutdown)
            process.once('SIGTERM', shutdown)
            async function shutdown() {
              await watcher.close()
            }
          }
        : undefined,
      paths: [
        artifactsDirectory,
        ...include.map((x) => `${artifactsDirectory}/**/${x}`),
        ...exclude.map((x) => `!${artifactsDirectory}/**/${x}`),
      ],
      async onAdd(path) {
        return getContract(path)
      },
      async onChange(path) {
        return getContract(path)
      },
      async onRemove(path) {
        const filename = basename(path)
        const extension = extname(path)
        // Since we can't use `getContractName`, guess from path
        const removedContractName = `${namePrefix}${filename.replace(
          extension,
          '',
        )}`
        const artifactPaths = await getArtifactPaths(artifactsDirectory)
        for (const artifactPath of artifactPaths) {
          const contract = await getContract(artifactPath)
          // If contract with same name exists, don't remove
          if (contract.name === removedContractName) return
        }
        return removedContractName
      },
    },
  }
}
