#!/usr/bin/env swift
// make-dmg-background.swift — 生成 DMG 窗口背景图 assets/dmg-background.png。
//
// 为什么需要它:electron-builder 的 dmg 目标默认只摆两个图标(无引导);
// 需求指定「DSH Box.app 与 Applications 之间放一个指向箭头」,箭头只能画在
// 背景图里(内容是 Finder 渲染在背景之上的图标)。
//
// 产物约定(与 build.mac.dmg.contents 的图标槽位严格对齐):
//   - 尺寸 540×380(build.dmg 未显式配 window 时,窗口大小 = 背景图大小);
//   - 图标槽位:DSH Box.app 中心 (170,260),Applications 中心 (450,260)
//     (80px 图标 → 左上 (130,220)/(410,220),与 electron-builder 默认一致);
//   - 背景内容:深色渐变 + 品牌蓝柔光 + 顶部标题 + 图标间虚线引导箭头 +
//     底部「拖入 Applications」提示。
//
// 运行(任意目录,产物落 cwd 下;本仓库在根目录执行):
//   swift scripts/make-dmg-background.swift                      → assets/dmg-background.png
//   swift scripts/make-dmg-background.swift assets/dmg-bg@2x.png 2 → 2x(Retina)版本
//   npm run make-dmg-bg                                          → 同上(1x)
//
// 正在使用:assets/dmg-background.png + assets/dmg-background@2x.png 已提交,
// 重跑本脚本可再生成。electron-builder 发现同目录 @2x 文件会自动
// tiffutil -cathidpicheck 合成多分辨率 DMG 背景(Retina 下文字不发虚)。

import AppKit

// ---------- 画布 ----------
let W: CGFloat = 540
let H: CGFloat = 380
// 渲染倍率:1x 正常;2x 供 Retina(@2x 文件,electron-builder 自动合成)
let scale: CGFloat = CommandLine.arguments.count > 2 ? CGFloat(Double(CommandLine.arguments[2]) ?? 1) : 1

// ---------- 品牌色(dsh design tokens,暗色套) ----------
// state-business-primary(dark)= deepseek-400 rgb(103,158,254);文中用 450 强调:
// 浅一点更醒目 → rgb(86,134,254) #5686FE
let brandBlue = NSColor(calibratedRed: 86.0 / 255.0, green: 134.0 / 255.0, blue: 254.0 / 255.0, alpha: 1)
let titleWhite = NSColor.white
let captionGray = NSColor(calibratedRed: 154.0 / 255.0, green: 163.0 / 255.0, blue: 181.0 / 255.0, alpha: 1)

// 背景深浅(顶浅底深,玻璃感)
let bgTop = NSColor(calibratedRed: 0.129, green: 0.14, blue: 0.184, alpha: 1)    // #212633
let bgBottom = NSColor(calibratedRed: 0.051, green: 0.059, blue: 0.078, alpha: 1) // #0D0F14

guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(W * scale),
  pixelsHigh: Int(H * scale),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fatalError("创建位图失败")
}
rep.size = NSSize(width: W * scale, height: H * scale)

NSGraphicsContext.saveGraphicsState()
guard let nsCtx = NSGraphicsContext(bitmapImageRep: rep) else {
  fatalError("创建绘图上下文失败")
}
NSGraphicsContext.current = nsCtx

// 翻转 + 缩放坐标:AppKit 默认左下原点 → 转成左上原点(顶部 y 小),
// 并按 scale 放大所有「逻辑像素」(布局代码用 1x 坐标,倍率只影响像素密度)
let flip = NSAffineTransform()
flip.translateX(by: 0, yBy: H * scale)
flip.scaleX(by: scale, yBy: -scale)
flip.concat()

// ---------- 1) 垂直渐变背景(顶浅底深) ----------
// 注意:经 flip 翻转后,angle 270 的 NSGradient 把 colors[0] 画在图像**底部**,
// 因此数组顺序与直觉相反:第一个颜色 = 底部深色,第二个 = 顶部浅色。
NSGradient(colors: [bgBottom, bgTop])!.draw(
  in: NSRect(x: 0, y: 0, width: W, height: H),
  angle: 270
)

// ---------- 2) 品牌蓝柔光:分别垫在两个图标槽背后 + 中间一道淡光 ----------
func glow(at center: NSPoint, radius: CGFloat, alpha: CGFloat) {
  let c = brandBlue.withAlphaComponent(alpha)
  let clear = brandBlue.withAlphaComponent(0)
  let r = NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
  NSGradient(colors: [c, clear])!.draw(in: r, relativeCenterPosition: .zero)
}
glow(at: NSPoint(x: 170, y: 260), radius: 150, alpha: 0.10) // DSH Box.app 图标槽
glow(at: NSPoint(x: 450, y: 260), radius: 150, alpha: 0.10) // Applications 图标槽
glow(at: NSPoint(x: 310, y: 250), radius: 240, alpha: 0.06) // 中间过渡光

// ---------- 3) 顶部品牌区 ----------
let title = NSAttributedString(
  string: "DSH Box",
  attributes: [
    .font: NSFont.systemFont(ofSize: 30, weight: .bold),
    .foregroundColor: titleWhite,
  ]
)
title.draw(at: NSPoint(x: (W - title.size().width) / 2, y: 58))

let subtitle = NSAttributedString(
  string: "DeepSeek Harness 桌面版",
  attributes: [
    .font: NSFont.systemFont(ofSize: 13),
    .foregroundColor: captionGray,
  ]
)
subtitle.draw(at: NSPoint(x: (W - subtitle.size().width) / 2, y: 96))

// ---------- 4) 引导箭头:App 图标右缘 → Applications 左缘(下弯虚线 + 箭头) ----------
// 图标槽:app 中心 (170,260) 80px → 右缘 x≈210;Applications 中心 (450,260) → 左缘 x≈410
let arrowPath = NSBezierPath()
arrowPath.move(to: NSPoint(x: 218, y: 258))
arrowPath.curve(
  to: NSPoint(x: 403, y: 262),
  controlPoint1: NSPoint(x: 310, y: 302),
  controlPoint2: NSPoint(x: 310, y: 302)
)
arrowPath.lineWidth = 3
arrowPath.lineCapStyle = .round
arrowPath.setLineDash([5, 5], count: 2, phase: 0)
brandBlue.setStroke()
arrowPath.stroke()

// 箭头头部:终点处的实心三角(指向 Applications 的右下方)
let tip = NSPoint(x: 403, y: 262)
let dirX: CGFloat = 0.9976 // normalize(1, 0.07) — 略朝右下,贴合曲线末端走向
let dirY: CGFloat = 0.0698
let len: CGFloat = 15
let halfW: CGFloat = 6
let base = NSPoint(x: tip.x - dirX * len, y: tip.y - dirY * len)
let p1 = NSPoint(x: base.x - dirY * halfW, y: base.y + dirX * halfW)
let p2 = NSPoint(x: base.x + dirY * halfW, y: base.y - dirX * halfW)
let head = NSBezierPath()
head.move(to: tip)
head.line(to: p1)
head.line(to: p2)
head.close()
brandBlue.setFill()
head.fill()

// ---------- 5) 底部引导文案 ----------
let caption = NSAttributedString(
  string: "将 DSH Box 拖入 Applications 文件夹完成安装",
  attributes: [
    .font: NSFont.systemFont(ofSize: 13),
    .foregroundColor: captionGray,
  ]
)
caption.draw(at: NSPoint(x: (W - caption.size().width) / 2, y: 346))

NSGraphicsContext.restoreGraphicsState()

// ---------- 输出 PNG ----------
guard let png = rep.representation(using: .png, properties: [:]) else {
  fatalError("PNG 编码失败")
}
let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/dmg-background.png"
try! png.write(to: URL(fileURLWithPath: outPath))
print("已生成 \(outPath) (\(Int(W * scale))×\(Int(H * scale)))")