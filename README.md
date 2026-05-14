# DeepSeek API Tester

一个本地运行的模型 API 测试小工具，用来观察 DeepSeek 或 OpenAI 兼容接口的请求、输出、耗时、token 和错误信息。

## 功能

- 填写 `API Key`、`Base URL`、`Model`、`System Prompt` 和用户输入。
- 调用 `/chat/completions` 格式的模型 API。
- 展示模型回复、请求预览、原始 JSON、耗时、token 和结束原因。
- 保存当前浏览器里的历史记录，方便对比不同 prompt 或模型。
- 支持复制完整请求 JSON，便于后续接入真实项目。
- 预留多模态入口：API 类型、图片上传、PDF 上传。

## 运行方式

需要先安装 Node.js。

方式一：双击启动

```powershell
start-deepseek-api-tester.bat
```

方式二：命令行启动

```powershell
node deepseek-api-tester.js
```

启动后打开：

```text
http://localhost:3000
```

## 页面字段说明

- `API Key`：你的模型平台密钥，只在本机请求时使用，不会保存到文件。
- `Base URL`：接口地址，例如 `https://api.deepseek.com`。
- `Model`：模型名称，例如 `deepseek-chat`。
- `API 类型`：当前主要支持 OpenAI 兼容文本格式，多模态为预留入口。
- `System Prompt`：控制模型角色、回答风格和输出规则。
- `用户输入`：要发送给模型的问题。
- `请求预览`：展示即将发送的请求结构，并隐藏 API Key。
- `原始 JSON`：展示接口返回的完整数据，方便排查问题。
- `历史记录`：保存在当前浏览器的 localStorage 中，不上传服务器。

## 注意事项

- 不要把真实 API Key 写进代码或提交到仓库。
- 当前工具不会保存上传的图片或 PDF。
- PDF 和图片入口目前只做预留，暂不真正发送给模型。
- 如果端口 `3000` 被占用，可以设置环境变量 `PORT` 后再启动。

## 文件说明

- `deepseek-api-tester.js`：单文件本地服务和页面。
- `start-deepseek-api-tester.bat`：Windows 双击启动脚本。
