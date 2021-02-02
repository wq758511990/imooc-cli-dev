'use strict';

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const fse = require('fs-extra');
const ejs = require('ejs');
const glob = require('glob')
const semver = require('semver');
const userHome = require('user-home');
const Command = require('@imooc-cli-dev/command');
const Package = require('@imooc-cli-dev/package');
const log = require('@imooc-cli-dev/log');
const { spinnerStart, sleep, execAsync } = require('@imooc-cli-dev/utils');

const getProjectTemplate = require('./getProjectTemplate');
const { execSync } = require('child_process');

const TYPE_PROJECT = 'project';
const TYPE_COMPONENT = 'component';

const TEMPLATE_TYPE_NORMAL = 'normal'
const TEMPLATE_TYPE_CUSTOM = 'custom'

const WHITE_COMMANDS = ['npm', 'cnpm']

class InitCommand extends Command {
  init () {
    this.projectName = this._argv[0] || '';
    this.force = !!this._cmd.force;
    log.verbose('projectName', this.projectName);
    log.verbose('force', this.force);
  }

  async exec () {
    try {
      // 1. 准备阶段
      const projectInfo = await this.prepare();
      if (projectInfo) {
        // 2. 下载模板
        log.verbose('projectInfo', projectInfo);
        this.projectInfo = projectInfo;
        await this.downloadTemplate();
        // 3. 安装模板
        await this.installTemplate()
      }
    } catch (e) {
      log.error(e.message);
      if (process.env.LOG_LEVEL === 'verbose') {
        console.log(e)
      }
    }
  }

  async installTemplate () {
    if (this.templateInfo) {
      if (!this.templateInfo.type) {
        this.templateInfo.type = TEMPLATE_TYPE_NORMAL
      }
      if (this.templateInfo.type === TEMPLATE_TYPE_NORMAL) {
        await this.installNormalTemplate()
      } else if (this.templateInfo.type === TEMPLATE_TYPE_CUSTOM) {
        await this.installCustomTemplate()
      } else {
        throw new Error('无法识别项目类型')
      }
    } else {
      throw new Error('项目模板信息不存在!')
    }
  }

  checkCommand (cmd) {
    if (WHITE_COMMANDS.indexOf(cmd) >= 0) {
      return cmd
    } else {
      return null
    }
  }

  async excuteCommand (command, errMsg) {
    let ret
    if (command && command.length > 0) {
      const execCommand = command.split(' ')
      const cmd = this.checkCommand(execCommand[0])
      if (!cmd) {
        throw new Error('命令不存在！命令：' + command)
      }
      const args = execCommand.slice(1)
      ret = await execAsync(cmd, args, {
        stdio: 'inherit',
        cwd: process.cwd()
      })
    }
    if (ret !== 0) {
      throw new Error(errMsg)
    }
    return ret
  }

  async ejsRender (options) {
    const dir = process.cwd()
    return new Promise((resolve, reject) => {
      glob('**', {
        cwd: dir,
        ignore: options.ignore,
        nodir: true // 不选择文件夹
      }, (err, files) => {
        if (err) {
          reject(err)
        }
        Promise.all(files.map(file => {
          const filePath = path.join(dir, file)
          return new Promise((resolve1, reject1) => {
            ejs.renderFile(filePath, this.projectInfo, {}, (err, result) => {
              if (err) {
                reject1(err)
              } else {
                fse.writeFileSync(filePath, result)
                resolve1(result)
              }
            })
          })
        })).then(() => {
          resolve()
        }).catch(err => {
          reject(err)
        })
      })
    })
  }

  async installNormalTemplate () {
    // 拷贝模板代码至当前目录
    let spinner = spinnerStart('正在安装模板')
    await sleep()
    try {
      const templatePath = path.resolve(this.templateNpm.cacheFilePath, 'template')
      const targetPath = process.cwd()
      fse.ensureDirSync(templatePath)
      fse.ensureDirSync(targetPath)
      fse.copySync(templatePath, targetPath)
    } catch (e) {
      throw e
    } finally {
      spinner.stop(true)
      log.success('模板安装成功')
    }
    const templateIgnore = this.templateInfo.ignore || []
    const ignore = ['**/node_modules/**', ...templateIgnore]
    await this.ejsRender({ ignore })
    // 依赖安装
    const { installCommand, startCommand } = this.templateInfo
    await this.excuteCommand(installCommand, '依赖安装过程中失败！')
    // 启动命令
    await this.excuteCommand(startCommand, '启动过程中失败！')
  }

  async installCustomTemplate () {
    if (await this.templateNpm.exists()) {
      const rootFile = this.templateNpm.getRootFilePath()
      if (fs.existsSync(rootFile)) {
        log.notice('开始执行自定义模板!')
        const templatePath = path.resolve(this.templateNpm.cacheFilePath, 'template');
        const options = {
          templateInfo: this.templateInfo,
          projectInfo: this.projectInfo,
          sourcePath: templatePath,
          targetPath: process.cwd(),
        };
        const code = `require('${rootFile}')(${JSON.stringify(options)})`;
        log.verbose('code', code)
        await execAsync('node', ['-e', code], { stdio: 'inherit', cwd: process.cwd() });
      } else {
        throw new Error('自定义模板入口文件不存在！')
      }
    }
  }

  async downloadTemplate () {
    const { projectTemplate } = this.projectInfo;
    const templateInfo = this.template.find(item => item.npmName === projectTemplate);
    const targetPath = path.resolve(userHome, '.imooc-cli-dev', 'template');
    const storeDir = path.resolve(userHome, '.imooc-cli-dev', 'template', 'node_modules');
    const { npmName, version } = templateInfo;
    this.templateInfo = templateInfo
    const templateNpm = new Package({
      targetPath,
      storeDir,
      packageName: npmName,
      packageVersion: version,
    });
    if (!await templateNpm.exists()) {
      const spinner = spinnerStart('正在下载模板...');
      await sleep();
      try {
        await templateNpm.install();
      } catch (e) {
        throw e;
      } finally {
        spinner.stop(true);
        if (templateNpm.exists()) {
          log.success('下载模板成功');
          this.templateNpm = templateNpm
        }

      }
    } else {
      const spinner = spinnerStart('正在更新模板...');
      await sleep();
      try {
        await templateNpm.update();
      } catch (e) {
        throw e;
      } finally {
        spinner.stop(true);
        if (templateNpm.exists()) {
          this.templateNpm = templateNpm
          log.success('更新模板成功');
        }
      }
    }
  }

  async prepare () {
    // 0. 判断项目模板是否存在
    const template = await getProjectTemplate();
    if (!template || template.length === 0) {
      throw new Error('项目模板不存在');
    }
    this.template = template;
    // 1. 判断当前目录是否为空
    const localPath = process.cwd();
    if (!this.isDirEmpty(localPath)) {
      let ifContinue = false;
      if (!this.force) {
        // 询问是否继续创建
        ifContinue = (await inquirer.prompt({
          type: 'confirm',
          name: 'ifContinue',
          default: false,
          message: '当前文件夹不为空，是否继续创建项目？',
        })).ifContinue;
        if (!ifContinue) {
          return;
        }
      }
      // 2. 是否启动强制更新
      if (ifContinue || this.force) {
        // 给用户做二次确认
        const { confirmDelete } = await inquirer.prompt({
          type: 'confirm',
          name: 'confirmDelete',
          default: false,
          message: '是否确认清空当前目录下的文件？',
        });
        if (confirmDelete) {
          // 清空当前目录
          fse.emptyDirSync(localPath);
        }
      }
    }
    return this.getProjectInfo();
  }

  async getProjectInfo () {
    function isValidName (v) {
      return /^[a-zA-Z]+([-][a-zA-Z][a-zA-Z0-9]*|[_][a-zA-Z][a-zA-Z0-9]*|[a-zA-Z0-9])*$/.test(v)
    }
    let projectInfo = {};
    let isProjectNameValid = false
    if (isValidName(this.projectName)) {
      isProjectNameValid = true
      projectInfo.projectName = this.projectName
    }
    // 1. 选择创建项目或组件
    const { type } = await inquirer.prompt({
      type: 'list',
      name: 'type',
      message: '请选择初始化类型',
      default: TYPE_PROJECT,
      choices: [{
        name: '项目',
        value: TYPE_PROJECT,
      }, {
        name: '组件',
        value: TYPE_COMPONENT,
      }],
    });
    log.verbose('type', type);
    this.template = this.template.filter(template => template.tag.includes(type))
    const title = type === TYPE_PROJECT ? '项目' : '组件'
    const projectNamePrompt = {
      type: 'input',
      name: 'projectName',
      message: `请输入${title}名称`,
      default: '',
      validate: function (v) {
        const done = this.async();
        setTimeout(function () {
          // 1.首字符必须为英文字符
          // 2.尾字符必须为英文或数字，不能为字符
          // 3.字符仅允许"-_"
          if (!isValidName(v)) {
            done(`请输入合法的${title}名称`);
            return;
          }
          done(null, true);
        }, 0);
      },
      filter: function (v) {
        return v;
      },
    }
    const projectPrompt = []
    if (!isProjectNameValid) {
      projectPrompt.push(projectNamePrompt)
    }
    projectPrompt.push({
      type: 'input',
      name: 'projectVersion',
      message: `请输入${title}版本号`,
      default: '1.0.0',
      validate: function (v) {
        const done = this.async();
        setTimeout(function () {
          if (!(!!semver.valid(v))) {
            done('请输入合法的版本号');
            return;
          }
          done(null, true);
        }, 0);
      },
      filter: function (v) {
        if (!!semver.valid(v)) {
          return semver.valid(v);
        } else {
          return v;
        }
      },
    }, {
      type: 'list',
      name: 'projectTemplate',
      message: `请选择${title}模板`,
      choices: this.createTemplateChoice(),
    })
    if (type === TYPE_PROJECT) {
      // 2. 获取项目的基本信息
      const project = await inquirer.prompt(projectPrompt);
      projectInfo = {
        ...projectInfo,
        type,
        ...project,
      };
    } else if (type === TYPE_COMPONENT) {
      const descriptionPrompt = {
        type: 'input',
        name: 'componentDescription',
        message: '请输入组件描述信息',
        default: '',
        validate: function (v) {
          const done = this.async();
          setTimeout(function () {
            if (!v) {
              done('请输入组件描述信息');
              return;
            }
            done(null, true);
          }, 0);
        }
      }
      projectPrompt.push(descriptionPrompt)
      // 2. 获取项目的基本信息
      const component = await inquirer.prompt(projectPrompt);
      projectInfo = {
        ...projectInfo,
        type,
        ...component,
      };
    }
    // 生成className
    if (projectInfo.projectName) {
      projectInfo.name = projectInfo.projectName
      projectInfo.className = require('kebab-case')(projectInfo.projectName).replace(/^-/, '')
    }
    if (projectInfo.projectVersion) {
      projectInfo.version = projectInfo.projectVersion
    }
    if (projectInfo.componentDescription) {
      projectInfo.description = projectInfo.componentDescription
    }
    return projectInfo;
  }

  isDirEmpty (localPath) {
    let fileList = fs.readdirSync(localPath);
    // 文件过滤的逻辑
    fileList = fileList.filter(file => (
      !file.startsWith('.') && ['node_modules'].indexOf(file) < 0
    ));
    return !fileList || fileList.length <= 0;
  }

  createTemplateChoice () {
    return this.template.map(item => ({
      value: item.npmName,
      name: item.name,
    }));
  }
}

function init (argv) {
  // console.log('init', projectName, cmdObj.force, process.env.CLI_TARGET_PATH);
  return new InitCommand(argv);
}

module.exports = init;
module.exports.InitCommand = InitCommand;
