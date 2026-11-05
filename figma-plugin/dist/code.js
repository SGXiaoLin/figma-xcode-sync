"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

  // src/code.ts
  var require_code = __commonJS({
    "src/code.ts"(exports) {
      figma.showUI(__html__, { width: 380, height: 640, title: "Xcode Asset Sync" });
      function sanitizeName(raw) {
        return raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
      }
      function getPageName() {
        return sanitizeName(figma.currentPage.name) || "page";
      }
      function buildIconName(node, pageName) {
        const cleanName = sanitizeName(node.name);
        return `${pageName}_ic_${cleanName || "icon"}`;
      }
      var exportChain = Promise.resolve();
      var exporting = false;
      function withExportLock(job) {
        const run = exportChain.then(job, job);
        exportChain = run.then(
          () => void 0,
          () => void 0
        );
        return run;
      }
      function hasImageFill(node) {
        if (!("fills" in node)) return false;
        try {
          const fills = node.fills;
          if (fills === figma.mixed || !Array.isArray(fills)) return false;
          return fills.some((paint) => paint.type === "IMAGE" && paint.visible !== false);
        } catch (_err) {
          return false;
        }
      }
      var EXPORTABLE_TYPES = /* @__PURE__ */ new Set([
        "FRAME",
        "COMPONENT",
        "INSTANCE",
        "GROUP",
        "COMPONENT_SET",
        "SECTION",
        "TRANSFORM_GROUP",
        "VECTOR",
        "BOOLEAN_OPERATION",
        "RECTANGLE",
        "ELLIPSE",
        "STAR",
        "POLYGON",
        "LINE",
        "TEXT",
        "TEXT_PATH",
        "SLICE"
      ]);
      function isExportableIcon(node) {
        return EXPORTABLE_TYPES.has(node.type) || hasImageFill(node);
      }
      function resolveExportNodes() {
        let selected = [];
        try {
          selected = figma.currentPage.selection;
        } catch (_err) {
          selected = [];
        }
        const nodes = selected.filter(isExportableIcon);
        return {
          nodes,
          skipped: Math.max(0, selected.length - nodes.length)
        };
      }
      function assignIconNames(nodes, pageName) {
        const used = /* @__PURE__ */ new Set();
        const names = /* @__PURE__ */ new Map();
        for (const node of nodes) {
          const base = buildIconName(node, pageName);
          let name = base;
          let suffix = 2;
          while (used.has(name)) {
            name = `${base}_${suffix++}`;
          }
          used.add(name);
          names.set(node.id, name);
        }
        return names;
      }
      function normalizeBase64(value) {
        const cleaned = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
        const remainder = cleaned.length % 4;
        return remainder === 0 ? cleaned : cleaned + "=".repeat(4 - remainder);
      }
      function isPNG(bytes) {
        return bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
      }
      function isSVG(bytes) {
        const limit = Math.min(bytes.length, 128);
        let start = 0;
        if (limit >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
          start = 3;
        }
        for (let i = start; i < limit; i++) {
          const byte = bytes[i];
          if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue;
          return byte === 60;
        }
        return false;
      }
      function exportNodeAsBytes(node, format, scale) {
        return __async(this, null, function* () {
          const settings = format === "PNG" ? { format: "PNG", constraint: { type: "SCALE", value: scale } } : { format: "SVG", svgOutlineText: false, svgIdAttribute: true };
          let bytes = yield withExportLock(() => node.exportAsync(settings));
          if (bytes.length === 0) {
            bytes = yield withExportLock(() => node.exportAsync(settings));
          }
          if (bytes.length === 0) {
            throw new Error(`"${node.name}" exported as empty ${format}.`);
          }
          if (format === "PNG" && !isPNG(bytes)) {
            throw new Error(`"${node.name}" export is not a PNG (${bytes.length} bytes).`);
          }
          if (format === "SVG" && !isSVG(bytes)) {
            throw new Error(`"${node.name}" export is not an SVG (${bytes.length} bytes).`);
          }
          const encoded = normalizeBase64(figma.base64Encode(bytes));
          const decoded = figma.base64Decode(encoded);
          if (decoded.length !== bytes.length || decoded[0] !== bytes[0]) {
            throw new Error(`"${node.name}" base64 round-trip failed.`);
          }
          return encoded;
        });
      }
      var CHUNK_SIZE = 24e3;
      function postEncoded(meta, data) {
        var _a;
        const transferId = `${meta.name}:${(_a = meta.scaleKey) != null ? _a : "svg"}:${Date.now()}:${Math.random()}`;
        const count = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
        for (let index = 0; index < count; index++) {
          figma.ui.postMessage({
            type: "export-chunk",
            transferId,
            index,
            count,
            chunk: data.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
            meta
          });
        }
        return transferId;
      }
      var SCALE_VALUES = [
        { key: "1x", value: 1 },
        { key: "2x", value: 2 },
        { key: "3x", value: 3 }
      ];
      function exportSelectedIcons(format, renderingMode, scales) {
        return __async(this, null, function* () {
          const nodes = resolveExportNodes().nodes;
          if (nodes.length === 0) {
            figma.ui.postMessage({ type: "error", message: "No icon frames selected." });
            return;
          }
          const activeScales = SCALE_VALUES.filter((s) => scales[s.key]);
          if (format === "PNG" && activeScales.length === 0) {
            figma.ui.postMessage({ type: "error", message: "Select at least one PNG scale." });
            return;
          }
          const pageName = getPageName();
          const iconNames = assignIconNames(nodes, pageName);
          figma.ui.postMessage({ type: "export-start", count: nodes.length });
          const transferIds = [];
          exporting = true;
          previewGeneration++;
          try {
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              const iconName = iconNames.get(node.id) || buildIconName(node, pageName);
              figma.ui.postMessage({
                type: "export-progress",
                current: i + 1,
                total: nodes.length,
                name: iconName
              });
              try {
                if (node.type === "INSTANCE") {
                  try {
                    yield node.getMainComponentAsync();
                  } catch (_err) {
                  }
                }
                if (format === "PNG") {
                  for (const s of activeScales) {
                    const encoded = yield exportNodeAsBytes(node, "PNG", s.value);
                    transferIds.push(
                      postEncoded(
                        {
                          name: iconName,
                          module: pageName,
                          format: "png",
                          renderingMode,
                          scaleKey: s.key
                        },
                        encoded
                      )
                    );
                  }
                } else {
                  const svgData = yield exportNodeAsBytes(node, "SVG", 1);
                  transferIds.push(
                    postEncoded(
                      {
                        name: iconName,
                        module: pageName,
                        format: "svg",
                        renderingMode,
                        scaleKey: null
                      },
                      svgData
                    )
                  );
                }
              } catch (err) {
                figma.ui.postMessage({
                  type: "export-item-error",
                  name: iconName,
                  error: String(err)
                });
              }
            }
            figma.ui.postMessage({ type: "export-ready", pageName, transferIds });
          } finally {
            exporting = false;
          }
        });
      }
      function safeSize(node, key) {
        try {
          const value = node[key];
          return typeof value === "number" ? value : 0;
        } catch (_err) {
          return 0;
        }
      }
      var lastSelectionKey = null;
      var previewGeneration = 0;
      var lastPreviewMessage = null;
      var lastThumbs = [];
      function sendSelectionPreview() {
        return __async(this, null, function* () {
          if (exporting) return;
          const resolved = resolveExportNodes();
          const nodes = resolved.nodes;
          const selectionKey = nodes.map((node) => node.id).join("|");
          if (selectionKey === lastSelectionKey) {
            if (lastPreviewMessage) figma.ui.postMessage(lastPreviewMessage);
            for (const thumb of lastThumbs) {
              figma.ui.postMessage({ type: "selection-thumb", id: thumb.id, thumb: thumb.thumb });
            }
            return;
          }
          lastSelectionKey = selectionKey;
          lastThumbs.length = 0;
          const generation = ++previewGeneration;
          const pageName = getPageName();
          const iconNames = assignIconNames(nodes, pageName);
          const preview = nodes.map((node) => ({
            id: node.id,
            name: node.name,
            iconName: iconNames.get(node.id) || buildIconName(node, pageName),
            width: safeSize(node, "width"),
            height: safeSize(node, "height")
          }));
          lastPreviewMessage = {
            type: "selection-preview",
            items: preview,
            pageName,
            skipped: resolved.skipped
          };
          figma.ui.postMessage(lastPreviewMessage);
          for (const node of nodes) {
            if (generation !== previewGeneration) return;
            try {
              const bytes = yield withExportLock(
                () => node.exportAsync({
                  format: "PNG",
                  constraint: { type: "WIDTH", value: 48 }
                })
              );
              if (generation !== previewGeneration || !isPNG(bytes)) continue;
              const thumb = `data:image/png;base64,${normalizeBase64(figma.base64Encode(bytes))}`;
              lastThumbs.push({ id: node.id, thumb });
              figma.ui.postMessage({ type: "selection-thumb", id: node.id, thumb });
            } catch (_err) {
            }
          }
        });
      }
      figma.on("selectionchange", sendSelectionPreview);
      sendSelectionPreview();
      figma.ui.onmessage = (msg) => __async(exports, null, function* () {
        switch (msg.type) {
          case "export":
            yield exportSelectedIcons(msg.format, msg.renderingMode, msg.scales);
            break;
          case "get-selection":
            sendSelectionPreview();
            break;
          case "get-folder": {
            const folder = yield figma.clientStorage.getAsync("destinationFolder");
            figma.ui.postMessage({
              type: "saved-folder",
              folder: typeof folder === "string" ? folder : ""
            });
            break;
          }
          case "set-folder":
            yield figma.clientStorage.setAsync("destinationFolder", msg.folder);
            break;
          case "close":
            figma.closePlugin();
            break;
        }
      });
    }
  });
  require_code();
})();
