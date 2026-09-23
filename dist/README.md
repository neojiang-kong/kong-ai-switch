# Dist

Pre-built artifacts for users who do not want to compile from source.

| File | Version | Platform | Notes |
| --- | --- | --- | --- |
| `KongAISwitch-macOS.zip` | 0.2.1 | macOS 13+ (arm64) | CLI bundled in the app. Needs Node.js 20+. Ad-hoc signed; first open may need right-click → Open. |

Rebuild after UI/CLI changes with `macapp/build-app.sh release`, then:

```bash
ditto -c -k --keepParent macapp/build/KongAISwitch.app dist/KongAISwitch-macOS.zip
```
