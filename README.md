# 嗅辨溯源 · 移动端 MVP

用"人的嗅觉 + 手机定位 + 当地气象"粗略反推污染源方位，不依赖浓度监测数据。

## 启动

双击项目根目录的 `启动手机版.bat`，然后：

- 电脑本机：http://localhost:8123
- 手机（同一 Wi-Fi）：http://电脑局域网IP:8123

电脑 IP 用 `ipconfig` 查看（IPv4 地址）。首次运行 Windows 防火墙可能弹窗，选"允许"。

## 使用流程

1. 打开页面 → 自动定位（或点击地图手动标点）
2. 自动显示当地天气：风向、风速、气温、湿度（Open-Meteo，免 key）
3. 按当下闻到的情况选择气味等级 1–5
4. 点击「提交嗅辨记录」→ 地图上画出**上风向扇形**和**估算位置圈**
5. 换几个位置重复提交，多个扇形交叠处即最可能的污染源区域

## 关键点

- **手机定位需要 HTTPS**。局域网 `http://IP:8123` 下浏览器不会弹出定位授权，此时点地图手动标点即可，天气与溯源功能不受影响。（要真机自动定位，需要 HTTPS 隧道或打包成 APK 使用原生定位。）
- **地图坐标系**：高德瓦片是 GCJ-02，手机 GPS 是 WGS-84。`js/coords.js` 做了双向转换：内部几何计算全部用 WGS-84，只在绘制和点击时转换，实测误差 < 1 米（`test/coords.test.js`）。
- 高德瓦片为演示用非官方直连；正式发布请改用**高德 JS API（申请免费 key）**，避免版权/授权问题。
- 扇形半角、各气味等级对应的距离区间都在 `js/app.js` 顶部的 `CONFIG` 里，可按实测标定。

## 自测

```bash
# 需先启动静态服务（8123）
node test/geo.test.js      # 球面几何：方位/距离/扇形顶点
node test/coords.test.js   # WGS-84 <-> GCJ-02 转换与往返精度
node test/e2e_cdp.js       # 端到端：390x844 视口 → 定位 → 真调天气 → 提交 → 截图
```

`e2e_cdp.js` 会自动启动 headless Edge，产出 `_e2e_before.png` / `_e2e_after.png`。

## 目录

```
mobile/
├── index.html
├── css/app.css
├── js/
│   ├── app.js        # 主逻辑（定位 / 天气 / 扇形 / 记录）
│   ├── geo.js        # 球面几何（浏览器 + Node 共用）
│   └── coords.js     # WGS-84 <-> GCJ-02
├── test/             # 单测 + CDP 端到端
└── vendor/leaflet/   # 本地 Leaflet 1.9.4，不依赖 CDN
```
