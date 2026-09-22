import SwiftUI

/// Official / vendor logomarks bundled under `Resources/`.
///
/// Kong uses the press-kit electric-lime logomark (#CCFF00). Vendor marks
/// identify Claude, OpenAI, Anthropic, and GitHub in the menu — trademarks
/// remain with their owners (see `Resources/ATTRIBUTION.txt`).
struct BrandMark: View {
    enum Kind {
        case agent(id: String, vendor: String?)
        case format(String)
        case provider(String?)
        case kong
    }

    let kind: Kind
    var size: CGFloat = 18

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let name = assetName, let image = bundledImage(name, displaySize: size) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
                    .modifier(GitHubContrast(invert: name == "github" && colorScheme == .dark))
            } else {
                fallbackBadge
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Resource basename without extension (`kong-logomark`, `openai`, …).
    private var assetName: String? {
        switch kind {
        case .kong:
            return "kong-logomark"
        case .agent(let id, let vendor):
            switch id {
            case "claude-code", "claude-desktop": return "claude"
            case "codex": return "openai"
            case "github-copilot": return "github"
            default:
                switch vendor {
                case "anthropic": return "claude"
                case "openai": return "openai"
                case "github": return "github"
                case "kong": return "kong-logomark"
                default: return nil
                }
            }
        case .format(let format):
            switch format.lowercased() {
            case "anthropic": return "anthropic"
            case "openai": return "openai"
            default: return nil
            }
        case .provider(let name):
            switch (name ?? "").lowercased() {
            case "anthropic": return "anthropic"
            case "claude": return "claude"
            case "openai": return "openai"
            case "github", "github-copilot", "copilot": return "github"
            default: return nil
            }
        }
    }

    private func bundledImage(_ name: String, displaySize: CGFloat) -> NSImage? {
        // SwiftPM copies processed Resources into Bundle.module.
        // Reset `size` so MenuBarExtra doesn't lay out at the PNG's pixel size
        // (our assets are ~128–256 pt until constrained).
        let urls = [
            Bundle.module.url(forResource: name, withExtension: "png"),
            Bundle.module.url(forResource: "\(name)@2x", withExtension: "png"),
        ].compactMap { $0 }
        for url in urls {
            guard let image = NSImage(contentsOf: url) else { continue }
            image.size = NSSize(width: displaySize, height: displaySize)
            return image
        }
        return nil
    }

    /// SF Symbol stand-in when a mark isn't bundled (e.g. Bedrock / Azure).
    private var fallbackBadge: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(fallbackBackground)
            Image(systemName: fallbackSymbol)
                .font(.system(size: size * 0.52, weight: .semibold))
                .foregroundStyle(fallbackForeground)
        }
    }

    private var fallbackSymbol: String {
        switch kind {
        case .agent(let id, let vendor):
            switch id {
            case "claude-code", "claude-desktop": return "sparkles"
            case "codex": return "terminal.fill"
            case "github-copilot": return "cat.fill"
            default:
                switch vendor {
                case "anthropic": return "sparkles"
                case "openai": return "terminal.fill"
                case "github": return "cat.fill"
                default: return "cpu.fill"
                }
            }
        case .format(let format):
            switch format.lowercased() {
            case "anthropic": return "sparkles"
            case "openai": return "circle.hexagongrid.fill"
            default: return "cube.fill"
            }
        case .provider(let name):
            switch (name ?? "").lowercased() {
            case "anthropic", "claude": return "sparkles"
            case "openai": return "circle.hexagongrid.fill"
            case "azure", "azure-openai": return "cloud.fill"
            case "bedrock", "aws": return "cylinder.split.1x2.fill"
            case "ollama": return "shippingbox.fill"
            case "cohere": return "waveform"
            case "gemini", "google": return "g.circle.fill"
            default: return "server.rack"
            }
        case .kong:
            return "diamond.fill"
        }
    }

    private var fallbackBackground: Color {
        fallbackForeground.opacity(0.18)
    }

    private var fallbackForeground: Color {
        switch kind {
        case .kong:
            return Color(red: 0.8, green: 1.0, blue: 0.0) // electric lime
        case .agent(_, let vendor):
            return brandColor(vendor)
        case .format(let format):
            return formatColor(format)
        case .provider(let name):
            return providerColor(name)
        }
    }

    private func brandColor(_ vendor: String?) -> Color {
        switch vendor {
        case "anthropic": return Color(red: 0.85, green: 0.47, blue: 0.34) // Claude clay
        case "openai": return Color(red: 0.06, green: 0.64, blue: 0.50)
        case "github": return Color(red: 0.14, green: 0.16, blue: 0.18)
        case "kong": return Color(red: 0.8, green: 1.0, blue: 0.0)
        default: return .secondary
        }
    }

    private func formatColor(_ format: String) -> Color {
        switch format.lowercased() {
        case "anthropic": return brandColor("anthropic")
        case "openai": return brandColor("openai")
        default: return .secondary
        }
    }

    private func providerColor(_ name: String?) -> Color {
        switch (name ?? "").lowercased() {
        case "anthropic", "claude": return brandColor("anthropic")
        case "openai": return brandColor("openai")
        case "azure", "azure-openai": return Color(red: 0.00, green: 0.47, blue: 0.83)
        case "bedrock", "aws": return Color(red: 0.92, green: 0.50, blue: 0.15)
        case "ollama": return Color(red: 0.20, green: 0.55, blue: 0.70)
        default: return .secondary
        }
    }
}

/// Invert the dark GitHub mark on dark backgrounds so it stays visible.
private struct GitHubContrast: ViewModifier {
    let invert: Bool
    func body(content: Content) -> some View {
        if invert {
            content.colorInvert()
        } else {
            content
        }
    }
}

/// Small text chip for format / auth labels.
struct MetaChip: View {
    let text: String
    var tint: Color = .secondary

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
    }
}
