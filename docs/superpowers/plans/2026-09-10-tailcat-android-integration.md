# Tailcat Android 直连集成计划

## 目标

Android App 继续使用现有 WebView 承载 Vue 页面，但由原生层直接建立 Tailcat 连接，不要求用户安装或运行 `tailcat forward`。Tailcat 只负责传输，ClawBench 现有 `/login` 密码认证、Cookie、自动登录和会话过期机制保持不变。

## Android 链路

```text
Tailcat 地址 → Android 原生 Tailcat 客户端 → 127.0.0.1:<临时端口>
→ WebView → 现有 Vue 登录页 → POST /login + Cookie
```

## 模块与接口

- 新增 `TailcatManager`：管理地址校验、启动/停止、临时本地端口、双向 TCP 代理、状态机、重连和错误码。
- 新增 `TailcatService`：以前台服务持有长连接，处理 `START`、`STOP`、`RECONNECT`、`ROTATE`，并在网络切换时重连。
- 新增 `mobile/tailcatbridge` Go mobile 包：隔离 `github.com/tailscale/tailcat`，向 Java 只暴露初始化、拨号、监听、转发和关闭接口。
- 扩展 `MainActivity.WebAppInterface`：异步提供 `startTailcat`、`stopTailcat`、`getTailcatState`、`reconnectTailcat`，通过 WebView 主线程回调状态。
- 不让 Java bridge 执行 shell 命令，也不把私钥、PSK 或完整敏感材料写入日志。

## 登录与持久化

- `login.html` 增加普通 URL / Tailcat 地址两种连接模式；Tailcat 模式先原生连接，再加载 localhost。
- Tailcat ready 后仍调用现有 `/login`，错误密码不能因为持有 Tailcat 地址而获得会话 Cookie。
- 新增独立偏好字段：`server_transport`、`server_input_url`、`tailcat_address`、`local_webview_url`、`tailcat_local_port`。
- 旧版本只有 `server_url` 时继续按普通 HTTP/HTTPS 登录。
- Tailcat 模式 WebView 只允许 localhost URL；服务停止、地址轮换或重连失败时清理本地 URL 并回到登录页。

## 构建与兼容

- 固定 Tailcat Go 版本并通过 Go modules 管理；Android 通过 gomobile 生成 arm64 AAR，不把 CLI 作为 APK 子进程。
- 根 `build.sh` 在 Android 构建前生成 binding；普通服务器构建不依赖 Android binding。
- 首阶段承诺 `android/arm64-v8a`，其他 ABI 需单独验证。
- SSH `BackgroundService` 保持不变；Tailcat 使用独立 `TailcatService`，同一 WebView 传输模式不允许 SSH 和 Tailcat 同时接管。

## 测试与验收

- Java 单测覆盖 TailcatManager 状态机、地址校验、端口冲突、超时、重连、停止释放资源和 bridge 回调。
- Service 测试覆盖前台服务命令、销毁清理、网络切换和重复启动。
- 登录页测试覆盖 Tailcat 连接中/成功/失败、普通登录回退和密码认证。
- arm64 设备或模拟器验证聊天、WebSocket、文件、终端、后台恢复、网络切换和地址轮换。
- 运行现有 Go、前端、Android 测试及构建检查，确保普通 HTTP/HTTPS、SSH 和 Tailcat 三种模式互不回归。
