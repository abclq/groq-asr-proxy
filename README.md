# groq-asr-proxy

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Deploy to Cloudflare](https://img.shields.io/badge/deploy-cloudflare-orange.svg)](https://workers.cloudflare.com)

统一语音转写（STT）网关，部署在 Cloudflare Workers（美国边缘出口），对外暴露 OpenAI 兼容的
`/v1/audio/transcriptions` 接口。解决 Groq 免费 ASR 在国内直连被 403 的问题，并提供多供应商兜底。

> 关联项目：[douyin-fav-kb](https://github.com/abclq/douyin-fav-kb) —— 抖音收藏夹→知识库，
> 其语音转写后端即使用本网关（Groq→腾讯云→本地硅基流动三层链路）。

---

## ✨ 特性

- **Groq 多 key 轮换**：自动在多个 Groq key 间尝试，绕过单 key 限流
- **腾讯云 ASR 兜底**：Groq 全失败时自动切换到腾讯云语音识别
- **本地第三层兜底**：调用方脚本可在网关全失败时回落到本机 SiliconFlow（详见下方"本地兜底"）
- **OpenAI 兼容**：直接复用现有 OpenAI SDK / curl 调用方式
- **零成本**：Groq + 腾讯云 ASR 均有免费额度

## 🏗 架构

```
客户端/任务脚本
   │  POST /v1/audio/transcriptions
   ▼
groq-asr-proxy (Cloudflare Workers, 美国出口)
   │  1. Groq whisper-large-v3-turbo  (多 key 轮换)
   │  2. 腾讯云 ASR SentenceRecognition  (云端兜底)
   │  3. (可选) 调用方本地 SiliconFlow 3001  (本机兜底，网关不可达内网)
   ▼
返回 { text, provider }
```

## 🚀 一键部署

```bash
# 1. 克隆
git clone https://github.com/abclq/groq-asr-proxy.git
cd groq-asr-proxy

# 2. 安装 wrangler
npm install -g wrangler
wrangler login        # 浏览器登录 Cloudflare

# 3. 配置（编辑 wrangler.toml）
#    - account_id: 你的 CF account_id
#    - GROQ_KEYS: 你的 Groq key（https://console.groq.com 申请，多个逗号分隔）
#    - TENCENT_SECRET_ID/KEY: 腾讯云 ASR 密钥（可选，留空则禁用兜底）

# 4. 设置鉴权 token（secret，不进仓库）
wrangler secret put AUTH_TOKEN
# 输入一个自定义 token，例如: my-secret-token-2026

# 5. 部署
wrangler deploy
```

部署成功后会得到地址：`https://groq-asr-proxy.<your-subdomain>.workers.dev`

## 📡 调用示例

```bash
curl -H "Authorization: Bearer <你的AUTH_TOKEN>" \
  -F "file=@audio.wav" \
  -F "model=whisper-large-v3-turbo" \
  -F "language=zh" \
  https://groq-asr-proxy.<your-subdomain>.workers.dev/v1/audio/transcriptions
```

返回：
```json
{ "text": "转写结果...", "provider": "groq-1" }
```

### 管理端点（免鉴权）

| 端点 | 说明 |
|------|------|
| `GET /info` | 返回 api_base、当前 auth、路由链、key 数量 |
| `GET /debug-keys` | 逐个 key 打 Groq `/v1/models`，看 200/403 状态 |
| `GET /health` | 存活检查 |

## 🔑 本地兜底（SiliconFlow）

网关运行在 Cloudflare 云端，**无法访问你的内网** `192.168.x.x:3001`。
因此第三层"硅基流动"兜底由**调用方脚本**实现：网关返回 `all_providers_failed` 时，
脚本自行调用本机 SiliconFlow（如 New API 3001 的 `FunAudioLLM/SenseVoiceSmall`）。

示例（`cf_stt.sh` 风格）：
```bash
# 先打网关，失败再打本地 3001
curl -s ... https://你的网关/v1/audio/transcriptions && exit 0
curl -s -H "Authorization: Bearer $LOCAL_KEY" \
  -F "file=@$1" -F "model=FunAudioLLM/SenseVoiceSmall" -F "language=zh" \
  http://127.0.0.1:3001/v1/audio/transcriptions
```

## ⚙️ 路由顺序说明

1. **Groq**（主力）：免费、快，经 CF 美国出口绕过国内 403
2. **腾讯云 ASR**：Groq 全 key 失败时兜底（需配置 TENCENT_SECRET_ID/KEY）
3. **本地 SiliconFlow**：网关与腾讯都挂时，由调用方脚本回落本机

## 📋 注意事项

- Groq 免费 key 密集请求会触发**临时 403 风控**（约 10–20 分钟自动恢复，非永久封）
- 腾讯云密钥请通过 `wrangler secret put` 设置，勿写入 wrangler.toml 提交到仓库
- AUTH_TOKEN 同理，用 secret 管理

## 📄 License

MIT
