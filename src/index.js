'use strict';

const { promisify } = require('util');
const childProcess = require('child_process');
const { join, relative, dirname } = require('path');

const fse = require('fs-extra');
const glob = require('fast-glob');
const _ = require('lodash');
const { getSchemaPath } = require('@prisma/internals');

const { getPrismaDir } = require('./utils');

const execPromise = promisify(childProcess.exec);

class ServerlessWebpackPrisma {
  defaultOuts = {
    'typegraphql-prisma': '@generated/type-graphql',
  };

  engines = [
    'node_modules/.prisma/client/query_engine*',
    '!node_modules/.prisma/client/query_engine-rhel*',

    'node_modules/prisma/query_engine*',
    '!node_modules/prisma/query_engine-rhel*',

    'node_modules/@prisma/engines/query_engine*',
    '!node_modules/@prisma/engines/query_engine-rhel*',

    'node_modules/@prisma/engines/migration-engine*',
    '!node_modules/@prisma/engines/migration-engine-rhel*',

    'node_modules/@prisma/engines/prisma-fmt*',
    '!node_modules/@prisma/engines/prisma-fmt-rhel*',

    'node_modules/@prisma/engines/introspection-engine*',
    '!node_modules/@prisma/engines/introspection-engine-rhel*',

    'node_modules/@prisma/internals/**/query_engine*',
    'node_modules/@prisma/internals/**/libquery_engine*',

    '**/.cache/**',
  ];

  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.commands = {};
    this.hooks = {
      'after:webpack:package:packExternalModules':
        this.onBeforeWebpackPackage.bind(this),
    };
    this.outs = this.getOuts();
  }

  async onBeforeWebpackPackage() {
    const prismaPath = this.getPrismaPath();
    const webpackOutputPath = this.getWebpackOutputPath();
    const prismaSchema = await getSchemaPath();
    const prismaDir = dirname(prismaSchema);
    const relativePrisma = relative(prismaPath, prismaSchema);
    const relativeFolderPrisma = relative(prismaPath, prismaDir);
    const functionNames = this.getFunctionNamesForProcess();
    const outputPath = webpackOutputPath || join(prismaPath, '.webpack');
    for (const functionName of functionNames) {
      const cwd = join(outputPath, functionName);
      const { targetPrismaDir } = getPrismaDir(
        cwd,
        relativeFolderPrisma,
        relativePrisma
      );
      this.copyPrismaSchemaToFunction({
        functionName,
        targetPrismaDir,
        prismaDir,
        cwd,
      });
      const packages = [];
      packages.push(this.installPlugins());
      if (this.getDepsParam()) packages.push(this.installPrismaPackage());
      if (packages.length)
        await this.runPackageInstallCommand({
          packageName: packages.join(' '),
          cwd,
          dev: true,
        });
      await this.generatePrismaSchema({ functionName, cwd });
      this.deleteUnusedEngines({ functionName, cwd });
      // Evit that the packages generated by the plugins are removed
      this.moveGeneratedFilesToRoot({ cwd });
      await this.removePrismaPackage({ cwd });
      await this.uninstallPlugins({ cwd });
      // Restore the node_modules folder
      this.moveGeneratedFilesToNodeModules({ cwd });
    }
  }

  moveGeneratedFilesToRoot({ cwd }) {
    const plugins = this.getPlugins();
    for (const plugin of plugins) {
      const dir = this.outs[plugin];
      if (!dir) continue;
      try {
        fse.moveSync(join(cwd, `node_modules/${dir}`), join(cwd, dir), {
          overwrite: true,
        });
      } catch (e) {
        // ignore
      }
    }
  }

  moveGeneratedFilesToNodeModules({ cwd }) {
    const plugins = this.getPlugins();
    for (const plugin of plugins) {
      const dir = this.outs[plugin];
      if (!dir) continue;
      try {
        fse.moveSync(join(cwd, dir), join(cwd, `node_modules/${dir}`), {
          overwrite: true,
        });
      } catch (e) {
        // ignore
      }
    }
  }

  getPackageManager() {
    return _.get(this.serverless, 'service.custom.webpack.packager', 'npm');
  }

  async runPackageInstallCommand({ packageName, cwd, dev }) {
    let params = '';
    if (dev) params += '-D ';
    const command =
      this.getPackageManager() === 'npm'
        ? `npm install ${params}${packageName} --ignore-scripts`
        : `yarn add ${params}${packageName}`;
    return execPromise(`${command}`, { cwd });
  }

  installPlugins() {
    this.log('Install plugins');
    const plugins = this.getPlugins();
    if (!plugins.length) return;
    for (const plugin of plugins) {
      this.log(`Install plugin ${plugin}`);
    }
    return plugins.join(' ');
  }

  async uninstallPlugins({ cwd }) {
    this.log('Uninstall plugins');
    const plugins = this.getPlugins();
    if (!plugins.length) return;
    await this.runPackageRemoveCommand({
      packageName: plugins.join(' '),
      cwd,
    });
  }

  async runPackageRemoveCommand({ packageName, cwd }) {
    const command =
      this.getPackageManager() === 'npm'
        ? `npm remove ${packageName}`
        : `yarn remove ${packageName}`;
    return execPromise(command, { cwd });
  }

  installPrismaPackage() {
    this.log('Install prisma devDependencies for generate');
    return 'prisma';
  }

  async removePrismaPackage({ cwd }) {
    this.log('Remove prisma devDependencies');
    await this.runPackageRemoveCommand({
      packageName: 'prisma',
      cwd,
    });
  }

  copyPrismaSchemaToFunction({
    functionName,
    cwd,
    prismaDir,
    targetPrismaDir: targetPrismaDirBase,
  }) {
    const targetPrismaDir = targetPrismaDirBase || join(cwd, 'prisma');
    this.log(`Copy prisma schema for ${functionName}...`);
    fse.copySync(prismaDir, targetPrismaDir, {
      filter: (src) => {
        const path = relative(prismaDir, src);
        return !path.startsWith('node_modules');
      },
    });
  }

  generateCommand() {
    let command = 'npx prisma generate';
    if (this.isDataProxyParam()) {
      this.serverless.cli.log(`Prisma data proxy is enabled.`);
      command += ' --data-proxy';
    }

    return command;
  }

  generatePrismaSchema({ functionName, cwd }) {
    this.log(`Generate prisma client for ${functionName}...`);
    const promise = execPromise(this.generateCommand(), {
      cwd,
    });
    const child = promise.child;
    if (child) child.stdout.pipe(process.stdout);
    return promise;
  }

  deleteUnusedEngines({ cwd }) {
    const unusedEngines = glob.sync(this.engines, { cwd });
    if (unusedEngines.length <= 0) return;
    this.log(`Remove unused prisma engine:`);
    unusedEngines.forEach((engine) => {
      this.log(`  - ${engine}`);
      const enginePath = join(cwd, engine);
      fse.removeSync(enginePath, { force: true });
    });
  }

  getFunctionNamesForProcess() {
    const packageIndividually =
      this.serverless.configurationInput.package &&
      this.serverless.configurationInput.package.individually;
    return packageIndividually ? this.getAllNodeFunctions() : ['service'];
  }

  getPrismaPath() {
    return _.get(
      this.serverless,
      'service.custom.prisma.prismaPath',
      this.serverless.config.servicePath
    );
  }

  getWebpackOutputPath() {
    const serverlessWebpack = this.getServerlessWebpack();

    return (
      (serverlessWebpack && serverlessWebpack.webpackOutputPath) ||
      _.get(
        this.serverless,
        'service.custom.webpack.webpackOutputPath',
        this.serverless.config.servicePath
      )
    );
  }

  getPlugins() {
    return _.get(this.serverless, 'service.custom.prisma.plugins', []);
  }

  getOuts() {
    const outs = _.get(this.serverless, 'service.custom.prisma.outs', {});
    return {
      ...this.defaultOuts,
      ...outs,
    };
  }

  getDepsParam() {
    return _.get(this.serverless, 'service.custom.prisma.installDeps', true);
  }

  isDataProxyParam() {
    return _.get(this.serverless, 'service.custom.prisma.dataProxy', false);
  }

  log(message) {
    this.serverless.cli.log(`[prisma-generate] ${message}`);
  }

  getServerlessWebpack() {
    const webpack = this.serverless.pluginManager.commands.webpack.pluginName;
    return this.serverless.pluginManager.plugins.find(
      (plugin) => plugin.constructor.name === webpack
    );
  }

  // Ref: https://github.com/serverless-heaven/serverless-webpack/blob/4785eb5e5520c0ce909b8270e5338ef49fab678e/lib/utils.js#L115
  getAllNodeFunctions() {
    const functions = this.serverless.service.getAllFunctions();

    return functions.filter((funcName) => {
      const func = this.serverless.service.getFunction(funcName);

      // if `uri` is provided or simple remote image path, it means the
      // image isn't built by Serverless so we shouldn't take care of it
      if (
        (func.image && func.image.uri) ||
        (func.image && typeof func.image == 'string')
      ) {
        return false;
      }

      return this.isNodeRuntime(
        func.runtime || this.serverless.service.provider.runtime || 'nodejs'
      );
    });
  }

  isNodeRuntime(runtime) {
    return runtime.match(/node/);
  }
}

module.exports = ServerlessWebpackPrisma;
