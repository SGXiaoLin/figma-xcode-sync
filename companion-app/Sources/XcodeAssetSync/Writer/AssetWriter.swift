import Foundation

/// Writes icon assets into an Xcode .xcassets catalog.
/// Creates the .imageset folder + scale PNGs or SVG + Contents.json.
struct AssetWriter {

    enum WriteError: Error, LocalizedError {
        case missingXcassetsPath(module: String)
        case invalidBase64(iconName: String)
        case emptyExport(iconName: String)
        case corruptImage(iconName: String, detail: String)
        case fileSystemError(String)

        var iconName: String {
            switch self {
            case .missingXcassetsPath, .fileSystemError:
                return "unknown"
            case .invalidBase64(let name), .emptyExport(let name), .corruptImage(let name, _):
                return name
            }
        }

        var errorDescription: String? {
            switch self {
            case .missingXcassetsPath(let m): return "No xcassets path configured for module '\(m)'"
            case .invalidBase64(let n):       return "Invalid base64 data for icon '\(n)'"
            case .emptyExport(let n):         return "Export data for icon '\(n)' is empty"
            case .corruptImage(let n, let detail): return "Icon '\(n)' \(detail)"
            case .fileSystemError(let msg):   return msg
            }
        }
    }

    struct WriteResult {
        let name: String
        let path: String
        let skipped: Bool
        let reason: String?
    }

    private let config: ProjectConfig

    init(config: ProjectConfig) {
        self.config = config
    }

    // ── Public entry point ────────────────────────────────────────────────────

    func write(request: ImportRequest) -> (results: [WriteResult], errors: [WriteError]) {
        write(request: request, xcassetsOverride: nil)
    }

    /// When `xcassetsOverride` is set, all icons are written directly to that
    /// .xcassets folder, bypassing the module-based config lookup.
    func write(request: ImportRequest, xcassetsOverride: URL?) -> (results: [WriteResult], errors: [WriteError]) {
        var results: [WriteResult] = []
        var errors: [WriteError] = []

        if let message = Self.invalidFolderMessage(request.folder) {
            return ([], [.fileSystemError(message)])
        }

        var reservedNames: Set<String> = []
        for icon in request.icons {
            do {
                let result = try writeIcon(
                    icon,
                    folder: request.folder,
                    xcassetsOverride: xcassetsOverride,
                    reservedNames: &reservedNames
                )
                results.append(result)
            } catch let err as WriteError {
                errors.append(err)
            } catch {
                errors.append(.fileSystemError(error.localizedDescription))
            }
        }

        return (results, errors)
    }

    // ── Write single icon ─────────────────────────────────────────────────────

    private func writeIcon(
        _ icon: IconPayload,
        folder: String?,
        xcassetsOverride: URL? = nil,
        reservedNames: inout Set<String>
    ) throws -> WriteResult {
        let xcassetsURL: URL
        if let configuredPath = config.xcassetsPath(for: icon.module) {
            // A configured module path (which may point at a subfolder inside
            // .xcassets) always wins over whatever Xcode currently has focused.
            xcassetsURL = URL(fileURLWithPath: configuredPath)
        } else if let override = xcassetsOverride {
            xcassetsURL = override
        } else {
            throw WriteError.missingXcassetsPath(module: icon.module)
        }

        // 子目录按路径分量拼接，避免把 "Geo Photos/image" 写进 imageset 文件名。
        let destination = Self.appendingSubfolder(xcassetsURL, folder)
        // 目录里已有同名 imageset 时不覆盖，改写成 name_2、name_3。
        // 再清洗一次，防止插件侧漏掉 / 等特殊字符导致路径报错。
        let assetName = try availableAssetName(
            Self.sanitizeAssetName(icon.name),
            in: destination,
            reserved: &reservedNames
        )
        let imagesetPath = destination.appendingPathComponent("\(assetName).imageset")

        try FileManager.default.createDirectory(at: imagesetPath, withIntermediateDirectories: true)

        if icon.format == "svg" {
            try writeSVG(name: assetName, icon: icon, at: imagesetPath)
        } else {
            try writePNG(name: assetName, icon: icon, at: imagesetPath)
        }

        return WriteResult(name: assetName, path: imagesetPath.path, skipped: false, reason: nil)
    }

    /// 与 Figma 插件一致：只保留字母数字和下划线，/ 等特殊字符换成 _。
    private static func sanitizeAssetName(_ raw: String) -> String {
        let lowered = raw.lowercased()
        var result = ""
        result.reserveCapacity(lowered.count)
        var lastWasUnderscore = false
        for scalar in lowered.unicodeScalars {
            let isAllowed =
                (scalar >= "a" && scalar <= "z") ||
                (scalar >= "0" && scalar <= "9") ||
                scalar == "_"
            if isAllowed {
                result.unicodeScalars.append(scalar)
                lastWasUnderscore = scalar == "_"
            } else if !lastWasUnderscore {
                result.append("_")
                lastWasUnderscore = true
            }
        }
        while result.hasPrefix("_") { result.removeFirst() }
        while result.hasSuffix("_") { result.removeLast() }
        return result.isEmpty ? "icon" : result
    }

    /// 同一批里后选中的名字也算占用，避免两张图抢到同一个空位。
    private func availableAssetName(_ requested: String, in destination: URL, reserved: inout Set<String>) throws -> String {
        let fm = FileManager.default
        var suffix = 1
        while suffix < 1000 {
            let candidate = suffix == 1 ? requested : "\(requested)_\(suffix)"
            suffix += 1
            if reserved.contains(candidate) { continue }
            let imagesetPath = destination.appendingPathComponent("\(candidate).imageset").path
            if fm.fileExists(atPath: imagesetPath) { continue }
            reserved.insert(candidate)
            return candidate
        }
        throw WriteError.fileSystemError("No free name for icon '\(requested)'.")
    }

    // ── PNG ───────────────────────────────────────────────────────────────────

    private func writePNG(name: String, icon: IconPayload, at imagesetURL: URL) throws {
        guard let scales = icon.scales, !scales.isEmpty else {
            throw WriteError.emptyExport(iconName: icon.name)
        }

        var images: [[String: String]] = []

        let scaleMap: [(key: String, suffix: String, scale: String)] = [
            ("1x", "",    "1x"),
            ("2x", "@2x", "2x"),
            ("3x", "@3x", "3x"),
        ]

        // Only the scales actually present in the payload are written —
        // the Figma plugin only sends the scales the user selected.
        for entry in scaleMap {
            guard let base64 = scales[entry.key] else { continue }
            let data = try decodeImage(base64, iconName: icon.name, format: "png")

            let filename = "\(name)\(entry.suffix).png"
            let fileURL = imagesetURL.appendingPathComponent(filename)
            try data.write(to: fileURL, options: .atomic)

            images.append([
                "idiom":    "universal",
                "filename": filename,
                "scale":    entry.scale,
            ])
        }

        guard !images.isEmpty else {
            throw WriteError.emptyExport(iconName: icon.name)
        }

        try writeContentsJSON(
            at: imagesetURL,
            images: images,
            renderingMode: icon.renderingMode
        )
    }

    // ── SVG ───────────────────────────────────────────────────────────────────

    private func writeSVG(name: String, icon: IconPayload, at imagesetURL: URL) throws {
        guard let base64 = icon.data else {
            throw WriteError.emptyExport(iconName: icon.name)
        }
        let data = try decodeImage(base64, iconName: icon.name, format: "svg")

        let filename = "\(name).svg"
        let fileURL = imagesetURL.appendingPathComponent(filename)
        try data.write(to: fileURL, options: .atomic)

        let images: [[String: String]] = [[
            "idiom":    "universal",
            "filename": filename,
        ]]

        try writeContentsJSON(
            at: imagesetURL,
            images: images,
            renderingMode: icon.renderingMode,
            isSVG: true
        )
    }

    /// `..` 和绝对路径会被拒绝，避免写出 catalog 外面。
    private static func invalidFolderMessage(_ folder: String?) -> String? {
        guard let folder else { return nil }
        let trimmed = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("~") {
            return "Folder must be a relative path inside the catalog."
        }
        for raw in trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" }) {
            let part = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if part == ".." { return "Folder cannot contain '..'." }
        }
        return nil
    }

    private static func appendingSubfolder(_ base: URL, _ folder: String?) -> URL {
        guard let folder else { return base }
        let trimmed = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return base }
        return trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" }).reduce(base) { url, raw in
            let part = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if part.isEmpty || part == "." { return url }
            return url.appendingPathComponent(part, isDirectory: true)
        }
    }

    /// 补齐 padding、忽略空白。空数据或文件头不对时直接失败，避免写成空 imageset。
    private func decodeImage(_ raw: String, iconName: String, format: String) throws -> Data {
        guard let data = Self.decodeBase64(raw) else {
            throw WriteError.invalidBase64(iconName: iconName)
        }
        guard !data.isEmpty else {
            throw WriteError.emptyExport(iconName: iconName)
        }
        if format == "png" {
            let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
            if data.count < 8 || [UInt8](data.prefix(4)) != pngMagic {
                throw WriteError.corruptImage(iconName: iconName, detail: "is not a valid PNG")
            }
        } else if let text = String(data: data.prefix(128), encoding: .utf8),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("<") {
            throw WriteError.corruptImage(iconName: iconName, detail: "is not a valid SVG")
        }
        return data
    }

    private static func decodeBase64(_ raw: String) -> Data? {
        let stripped = raw
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = stripped.count % 4
        let padded = remainder == 0 ? stripped : stripped + String(repeating: "=", count: 4 - remainder)
        return Data(base64Encoded: padded, options: .ignoreUnknownCharacters)
    }

    // ── Contents.json ─────────────────────────────────────────────────────────

    private func writeContentsJSON(
        at imagesetURL: URL,
        images: [[String: String]],
        renderingMode: String,
        isSVG: Bool = false
    ) throws {
        let info: [String: Any] = [
            "version": 1,
            "author":  "xcode-asset-sync",
        ]

        var properties: [String: Any] = [:]

        if renderingMode == "template" {
            properties["template-rendering-intent"] = "template"
        }

        if isSVG {
            properties["preserves-vector-representation"] = true
        }

        var contents: [String: Any] = [
            "images": images,
            "info":   info,
        ]

        if !properties.isEmpty {
            contents["properties"] = properties
        }

        let data = try JSONSerialization.data(
            withJSONObject: contents,
            options: [.prettyPrinted, .sortedKeys]
        )

        let contentsURL = imagesetURL.appendingPathComponent("Contents.json")
        try data.write(to: contentsURL, options: .atomic)
    }
}
