# Prompt 实验台

一个本地运行的 Prompt 对比工具，用来在同一输入下比较多个 Prompt 版本和多个 OpenAI 兼容模型的输出。

## 功能

- 配置多个模型，保存 `API Key`、`Base URL`、`Model`、平台预设和 DeepSeek/方舟思考模式开关。
- 创建项目，并在项目内维护多个 Prompt 版本。
- 每个 Prompt 版本包含 `System Prompt` 和 `User Prompt`。
- 用同一组变量值一次运行多个 Prompt 与多个模型的交叉矩阵。
- 展示每个组合的回复、请求预览、原始 JSON、耗时、token 和错误信息，并可进入完整阅读详情。
- 按项目保存完整实验历史，历史中保留运行时 Prompt 和模型快照。
- 支持从 Prompt 中识别 `{{input}}` 和 `{{viewpoint}}` 这类变量后再发起请求。
- 支持按项目保存整套变量样例，并载入到当前实验。
- 支持在矩阵和单 Prompt 横向模型对比之间切换。
- 支持在模型回复的 Markdown 原文和渲染视图之间切换。

## 运行方式

需要先安装 Node.js。

方式一：Mac 双击启动

```bash
start-deepseek-api-tester.command
```

如果 macOS 提示文件无法执行，可以在项目目录执行一次：

```bash
chmod +x start-deepseek-api-tester.command
```

方式二：Windows 双击启动

```powershell
start-deepseek-api-tester.bat
```

方式三：命令行启动

```bash
node deepseek-api-tester.js
```

启动后打开：

```text
http://127.0.0.1:3000
```

## 页面说明

- `实验`：切换项目、编辑 Prompt 版本、选择 Prompt 和模型、填写变量、运行结果矩阵。
- `模型配置`：维护模型名称、平台预设、`API Key`、`Base URL`、`Model`、API 类型和思考模式，并可先发起一次短请求测试配置。
- `变量`：从已选 Prompt 版本的 `System Prompt` 和 `User Prompt` 里识别 `{{变量名}}`，支持逐个填写、批量填入和项目内变量样例复用；每个变量会提示哪些 Prompt 使用它。
- `结果矩阵`：行是 Prompt 版本，列是模型；单元格可打开完整详情，查看请求预览、最终 Prompt 和原始 JSON，也可切换到单 Prompt 横向模型对比。
- `项目历史`：保存每次运行的完整矩阵快照，回看历史不会被后续 Prompt 或模型配置修改影响。

## 注意事项

- 不要把真实 API Key 写进代码或提交到仓库。
- 第一版会把模型配置和 API Key 保存到本机数据文件：`~/.prompt-experiment-tester/data.json`。
- 第一版只覆盖文本 Prompt 对比，不处理图片、PDF 或其他多模态输入。
- 如果端口 `3000` 被占用，可以设置环境变量 `PORT` 后再启动。
- 模型请求由本地服务用直连方式发出，不读取 `HTTP_PROXY` / `HTTPS_PROXY` 这类代理环境变量；这样可避开常见的代理变量或系统代理转发问题。
- 如果 Node.js 自带的证书链无法校验模型站点证书，本地服务会再尝试一次系统自带的 `curl` HTTPS 客户端，复用操作系统的证书信任；不会关闭 HTTPS 证书校验。模型请求最长等待约 2 分钟。
- 如果代理软件开启了 TUN、透明代理或强制全局接管，仍可能在更底层拦截连接。此时请使用 `http://127.0.0.1:3000` 打开工具，并在代理软件的绕过/直连规则里加入 `localhost`、`127.0.0.1`、`::1` 和实际模型域名，例如 `api.deepseek.com`。

## 文件说明

- `deepseek-api-tester.js`：本地服务、存储和模型请求逻辑。
- `experiment-page.html`：Prompt 实验台页面。
- `start-deepseek-api-tester.command`：Mac 双击启动脚本。
- `start-deepseek-api-tester.bat`：Windows 双击启动脚本。
