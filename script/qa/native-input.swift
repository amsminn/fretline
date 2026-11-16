import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    } catch {
        FileHandle.standardError.write(Data("JSON encoding failed: \(error)\n".utf8))
        exit(2)
    }
}

// No activation, input event or screenshot precedes these two preflight checks.
let accessibility = AXIsProcessTrusted()
let screenRecording = CGPreflightScreenCaptureAccess()
if !accessibility || !screenRecording {
    emit(["status": "BLOCKED_PERMISSION", "accessibility": accessibility, "screenRecording": screenRecording])
    exit(3)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
func bounds(_ element: AXUIElement) -> [String: Any]? {
    guard let position = attribute(element, kAXPositionAttribute as CFString),
          let size = attribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
    return ["x": point.x, "y": point.y, "width": extent.width, "height": extent.height]
}
func elements(_ element: AXUIElement, _ depth: Int) -> [[String: Any]] {
    guard depth < 8 else { return [] }
    let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
    return children.flatMap { child -> [[String: Any]] in
        var result: [[String: Any]] = []
        if var rect = bounds(child) {
            rect["role"] = attribute(child, kAXRoleAttribute as CFString) as? String ?? ""
            rect["title"] = attribute(child, kAXTitleAttribute as CFString) as? String ?? ""
            result.append(rect)
        }
        return result + elements(child, depth + 1)
    }
}
let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("Missing native command") }
func number(_ index: Int) -> Double {
    guard args.indices.contains(index), let value = Double(args[index]), value.isFinite else { fail("Invalid numeric argument") }
    return value
}
func app(_ index: Int) -> NSRunningApplication {
    guard args.indices.contains(index), let pid = Int32(args[index]),
          let app = NSRunningApplication(processIdentifier: pid) else { fail("Missing target application") }
    return app
}
func event(_ type: CGEventType, _ point: CGPoint) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fail("CGEvent creation failed") }
    event.post(tap: .cghidEventTap)
}
switch command {
case "probe":
    emit(["status": "READY", "accessibility": true, "screenRecording": true])
case "focus":
    let target = app(1)
    guard target.activate(options: [.activateAllWindows]) else { fail("Application activation failed") }
    let application = AXUIElementCreateApplication(target.processIdentifier)
    guard let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement],
          let window = windows.first else { fail("AX window unavailable") }
    guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { fail("AX raise failed") }
    emit(["status": "FOCUSED", "pid": target.processIdentifier])
case "bounds":
    let target = app(1)
    let application = AXUIElementCreateApplication(target.processIdentifier)
    guard let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement],
          let window = windows.first, var rect = bounds(window) else { fail("AX bounds unavailable") }
    rect["elements"] = elements(window, 0)
    emit(rect)
case "click":
    let point = CGPoint(x: number(1), y: number(2))
    event(.mouseMoved, point)
    event(.leftMouseDown, point)
    event(.leftMouseUp, point)
    emit(["status": "CLICKED"])
case "drag":
    let start = CGPoint(x: number(1), y: number(2))
    let end = CGPoint(x: number(3), y: number(4))
    event(.leftMouseDown, start)
    for step in 1...24 {
        let ratio = Double(step) / 24
        event(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio))
        usleep(8_000)
    }
    event(.leftMouseUp, end)
    emit(["status": "DRAGGED"])
case "key":
    guard args.count >= 2, let key = UInt16(args[1]) else { fail("Invalid virtual keycode") }
    var flags: CGEventFlags = []
    for flag in args.dropFirst(2) {
        switch flag {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: fail("Unknown key modifier")
        }
    }
    for down in [true, false] {
        guard let keyEvent = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else { fail("Keyboard event unavailable") }
        keyEvent.flags = flags
        keyEvent.post(tap: .cghidEventTap)
    }
    emit(["status": "KEYED"])
case "screenshot":
    guard args.count == 3 else { fail("screenshot requires output path and PID") }
    let target = app(2)
    guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]],
          let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == target.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }),
          let id = window[kCGWindowNumber as String] as? Int else { fail("Visible window unavailable") }
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-l", String(id), args[1]]
    do { try capture.run() } catch { fail("screencapture launch: \(error)") }
    capture.waitUntilExit()
    guard capture.terminationStatus == 0 else { fail("screencapture failed") }
    emit(["status": "CAPTURED", "path": args[1]])
default:
    fail("Unknown native command: \(command)")
}
