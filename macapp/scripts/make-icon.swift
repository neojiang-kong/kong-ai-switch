// Renders the Kong AI Switch app icon into an .iconset directory.
//
// Usage: swift make-icon.swift <logomark.png> <out.iconset>
//
// The only official Kong logomark in the repo is a small raster (262 px), so
// the mark's alpha is upsampled and then re-thresholded: its edges are all
// straight lines, which survive this well and stay crisp at 1024 px.
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: make-icon.swift <logomark.png> <out.iconset>\n".data(using: .utf8)!)
    exit(2)
}
let logoURL = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])

let canvas = 1024
// Apple's macOS icon grid: 824 pt rounded-rect body inside a 1024 canvas.
let bodyInset: CGFloat = 100
let bodyRadius: CGFloat = 185.4
// Share of the body the mark's longest side may occupy.
let markFraction: CGFloat = 0.62
let lime = CGColor(srgbRed: 0.8, green: 1.0, blue: 0.0, alpha: 1)

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write("make-icon: \(msg)\n".data(using: .utf8)!)
    exit(1)
}

guard let src = NSImage(contentsOf: logoURL),
      let logo = src.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("cannot read \(logoURL.path)") }

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let gray = CGColorSpaceCreateDeviceGray()

/// Draws `image` into a grayscale buffer of the given size and returns its alpha as bytes.
func alphaMask(of image: CGImage, width: Int, height: Int) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: width * height)
    bytes.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: width, height: height,
                            bitsPerComponent: 8, bytesPerRow: width,
                            space: gray, bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue)!
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return bytes
}

// Tight bounding box of the mark (rows counted from the bottom, CG-style).
let srcMask = alphaMask(of: logo, width: logo.width, height: logo.height)
var minX = logo.width, minY = logo.height, maxX = -1, maxY = -1
for y in 0..<logo.height {
    for x in 0..<logo.width where srcMask[y * logo.width + x] > 24 {
        minX = min(minX, x); maxX = max(maxX, x)
        minY = min(minY, y); maxY = max(maxY, y)
    }
}
guard maxX >= minX else { fail("logomark appears empty") }
let bbox = CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)

// Upsample 8x, then sharpen alpha with a smoothstep around 50% coverage.
let up = 8
let bigW = logo.width * up, bigH = logo.height * up
var big = alphaMask(of: logo, width: bigW, height: bigH)
for i in 0..<big.count {
    let a = Double(big[i]) / 255
    let t = min(max((a - 0.38) / 0.24, 0), 1)
    big[i] = UInt8((t * t * (3 - 2 * t) * 255).rounded())
}
let sharpMask: CGImage = big.withUnsafeMutableBytes { buf in
    let ctx = CGContext(data: buf.baseAddress, width: bigW, height: bigH,
                        bitsPerComponent: 8, bytesPerRow: bigW,
                        space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    return ctx.makeImage()!
}

/// Renders the 1024 master icon.
func renderMaster() -> CGImage {
    let ctx = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8,
                        bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    let body = CGRect(x: bodyInset, y: bodyInset,
                      width: CGFloat(canvas) - 2 * bodyInset, height: CGFloat(canvas) - 2 * bodyInset)
    let bodyPath = CGPath(roundedRect: body, cornerWidth: bodyRadius, cornerHeight: bodyRadius, transform: nil)

    // Soft drop shadow under the body, as on stock macOS icons.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 28,
                  color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.35))
    ctx.addPath(bodyPath)
    ctx.setFillColor(CGColor(srgbRed: 0.04, green: 0.04, blue: 0.04, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    // Near-black vertical gradient.
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: space, colors: [
        CGColor(srgbRed: 0.13, green: 0.14, blue: 0.13, alpha: 1),
        CGColor(srgbRed: 0.03, green: 0.03, blue: 0.03, alpha: 1),
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: body.maxY),
                           end: CGPoint(x: 0, y: body.minY), options: [])

    // Mark, centered on its tight bounding box.
    let scale = body.width * markFraction / max(bbox.width, bbox.height)
    let markSize = CGSize(width: bbox.width * scale, height: bbox.height * scale)
    let origin = CGPoint(x: body.midX - markSize.width / 2, y: body.midY - markSize.height / 2)
    let fullRect = CGRect(x: origin.x - bbox.minX * scale, y: origin.y - bbox.minY * scale,
                          width: CGFloat(logo.width) * scale, height: CGFloat(logo.height) * scale)
    ctx.saveGState()
    ctx.clip(to: fullRect, mask: sharpMask)
    ctx.setFillColor(lime)
    ctx.fill(fullRect)
    ctx.restoreGState()
    ctx.restoreGState()

    // Hairline inner edge so the dark body reads on dark Docks.
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1.5, dy: 1.5),
                       cornerWidth: bodyRadius - 1.5, cornerHeight: bodyRadius - 1.5, transform: nil))
    ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.10))
    ctx.setLineWidth(3)
    ctx.strokePath()
    ctx.restoreGState()

    return ctx.makeImage()!
}

func resized(_ image: CGImage, to px: Int) -> CGImage {
    if px == image.width { return image }
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8,
                        bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: px, height: px))
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { fail("PNG encode failed") }
    do { try data.write(to: url) } catch { fail("cannot write \(url.path): \(error)") }
}

try? FileManager.default.removeItem(at: outDir)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let master = renderMaster()
for pt in [16, 32, 128, 256, 512] {
    writePNG(resized(master, to: pt), to: outDir.appendingPathComponent("icon_\(pt)x\(pt).png"))
    writePNG(resized(master, to: pt * 2), to: outDir.appendingPathComponent("icon_\(pt)x\(pt)@2x.png"))
}
print("wrote \(outDir.path)")
