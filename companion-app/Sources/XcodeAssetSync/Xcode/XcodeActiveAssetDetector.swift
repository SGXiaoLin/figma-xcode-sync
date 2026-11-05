import Cocoa
import ApplicationServices

enum XcodeAssetDetection {
    case found(URL)
    case xcodeNotRunning
    case accessibilityDenied
    case notAnAssetCatalog

    var failureMessage: String {
        switch self {
        case .found:
            return ""
        case .xcodeNotRunning:
            return "Xcode is not running. Open your project, click the .xcassets catalog, then sync again."
        case .accessibilityDenied:
            return "Accessibility permission is off for Xcode Asset Sync. Turn it on in System Settings → Privacy & Security → Accessibility, then open Xcode Asset Sync again."
        case .notAnAssetCatalog:
            return "Xcode is open, but the current editor file is not a .xcassets catalog. Click the catalog in the project navigator, then sync again."
        }
    }
}

/// 用辅助功能读取 Xcode 当前文档。Figma 在前台时 Xcode 没有焦点窗口，所以还要看主窗口和全部窗口。
enum XcodeActiveAssetDetector {

    static func detect() -> XcodeAssetDetection {
        guard let xcode = NSWorkspace.shared.runningApplications
            .first(where: { $0.bundleIdentifier == "com.apple.dt.Xcode" }) else {
            return .xcodeNotRunning
        }

        if !AXIsProcessTrusted() {
            // 未授权时让系统再弹一次。授权绑定的是当前签名，换过二进制后旧开关不会生效。
            let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(prompt)
            return .accessibilityDenied
        }

        let app = AXUIElementCreateApplication(xcode.processIdentifier)
        for element in candidateElements(of: app) {
            guard let path = documentPath(of: element) else { continue }
            if let catalog = xcassetsAncestor(of: URL(fileURLWithPath: path)) {
                return .found(catalog)
            }
        }
        return .notAnAssetCatalog
    }

    // MARK: - Private

    private static func candidateElements(of app: AXUIElement) -> [AXUIElement] {
        var elements: [AXUIElement] = []
        if let focused = copyElement(app, kAXFocusedWindowAttribute) {
            elements.append(focused)
        }
        if let main = copyElement(app, kAXMainWindowAttribute) {
            elements.append(main)
        }
        elements.append(contentsOf: copyElements(app, kAXWindowsAttribute))

        var current = copyElement(app, kAXFocusedUIElementAttribute)
        var depth = 0
        while let node = current, depth < 15 {
            elements.append(node)
            current = copyElement(node, kAXParentAttribute)
            depth += 1
        }
        return elements
    }

    private static func documentPath(of element: AXUIElement) -> String? {
        var docRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXDocumentAttribute as CFString, &docRef) == .success,
              let docStr = docRef as? String else { return nil }
        if docStr.hasPrefix("file://") {
            return URL(string: docStr)?.path
        }
        return docStr
    }

    private static func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as! AXUIElement?
    }

    private static func copyElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let items = value as? [AXUIElement] else { return [] }
        return items
    }

    /// Walks up from `url` until it finds an ancestor with `.xcassets` extension.
    private static func xcassetsAncestor(of url: URL) -> URL? {
        var current = url
        while current.path != "/" {
            if current.pathExtension == "xcassets" { return current }
            current = current.deletingLastPathComponent()
        }
        return nil
    }
}
