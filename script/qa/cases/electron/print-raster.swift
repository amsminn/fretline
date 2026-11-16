// Independent decoder for print QA: Apple CoreGraphics rasterizes every PDF page (and decodes exported
// PNGs) and reports ink statistics as JSON, so blank or clipped pages are detected without the exporter.
// usage: swift print-raster.swift <out-dir> <scale> <file.pdf|file.png>...
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct InkStats: Codable {
  let source: String
  let page: Int
  let width: Int
  let height: Int
  let inkPixels: Int
  let transparentPixels: Int
  let inkMinX: Int
  let inkMinY: Int
  let inkMaxX: Int
  let inkMaxY: Int
  let png: String?
}

func stats(of image: CGImage, source: String, page: Int, png: String?) -> InkStats {
  let width = image.width, height = image.height
  var buffer = [UInt8](repeating: 0, count: width * height * 4)
  let space = CGColorSpaceCreateDeviceRGB()
  guard let context = CGContext(data: &buffer, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("bitmap context") }
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  var ink = 0, transparent = 0, minX = width, minY = height, maxX = -1, maxY = -1
  for y in 0..<height {
    for x in 0..<width {
      let offset = (y * width + x) * 4
      let alpha = Int(buffer[offset + 3])
      if alpha == 0 { transparent += 1; continue }
      let luminance = (Int(buffer[offset]) * 299 + Int(buffer[offset + 1]) * 587 + Int(buffer[offset + 2]) * 114) / 1000
      if luminance < 160 * alpha / 255 {
        ink += 1
        if x < minX { minX = x }; if y < minY { minY = y }; if x > maxX { maxX = x }; if y > maxY { maxY = y }
      }
    }
  }
  return InkStats(source: source, page: page, width: width, height: height, inkPixels: ink, transparentPixels: transparent,
                  inkMinX: minX, inkMinY: minY, inkMaxX: maxX, inkMaxY: maxY, png: png)
}

func writePng(_ image: CGImage, to url: URL) {
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("png destination") }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) { fatalError("png write failed") }
}

let arguments = CommandLine.arguments
guard arguments.count >= 4, let scale = Double(arguments[2]) else {
  FileHandle.standardError.write("usage: print-raster.swift <out-dir> <scale> <files...>\n".data(using: .utf8)!)
  exit(64)
}
let outDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outDirectory, withIntermediateDirectories: true)
var results: [InkStats] = []
for path in arguments.dropFirst(3) {
  let url = URL(fileURLWithPath: path)
  if url.pathExtension.lowercased() == "pdf" {
    guard let document = CGPDFDocument(url as CFURL) else { fatalError("unreadable pdf \(path)") }
    for index in 1...max(1, document.numberOfPages) {
      guard let page = document.page(at: index) else { fatalError("missing page \(index)") }
      let box = page.getBoxRect(.mediaBox)
      let width = Int((box.width * scale).rounded()), height = Int((box.height * scale).rounded())
      let space = CGColorSpaceCreateDeviceRGB()
      guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("page context") }
      context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      context.scaleBy(x: scale, y: scale)
      context.drawPDFPage(page)
      guard let image = context.makeImage() else { fatalError("page image") }
      let pngName = "\(url.deletingPathExtension().lastPathComponent)-page\(index).png"
      writePng(image, to: outDirectory.appendingPathComponent(pngName))
      results.append(stats(of: image, source: url.lastPathComponent, page: index, png: pngName))
    }
  } else {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("unreadable image \(path)") }
    results.append(stats(of: image, source: url.lastPathComponent, page: 1, png: nil))
  }
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(results))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
