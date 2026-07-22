# SDK 构建镜像（脚手架）

`build-runner.Dockerfile` 是第一阶段镜像（arm-none-eabi-gcc，支持 SOURCE_COMPILED / MINIMAL_LINKED）。
达到 SDK_BUILD_PASSED 需要按平台扩展并**锁定版本**：

- mspm0：叠加 TI MSPM0 SDK（ti.com 下载需接受许可，无法在镜像内自动拉取，需挂载或私有源）
- stm32：叠加 CMSIS + STM32 HAL（可从 GitHub STMicroelectronics 组织拉取并锁 tag）
- esp32：直接使用 espressif/idf 官方镜像（锁定 IDF 版本 tag）

镜像构建与推送在你的 CI/本地完成；runner 内 TARGET_FLAGS 对应扩展 SDK 头文件与厂商 linker script 路径。
