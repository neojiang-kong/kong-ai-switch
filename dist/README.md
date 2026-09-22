# Dist

Pre-built artifacts for users who do not want to compile from source.

| File | Platform | Notes |
| --- | --- | --- |
| `KongAISwitch-macOS.zip` | macOS 13+ (arm64) | Unzip → drag `KongAISwitch.app` to Applications. Ad-hoc signed; first open may need right-click → Open. |

Rebuild after UI/CLI changes with `macapp/build-app.sh release`, then:

```bash
ditto -c -k --keepParent macapp/build/KongAISwitch.app dist/KongAISwitch-macOS.zip
```
