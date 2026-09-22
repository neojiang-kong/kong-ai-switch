import SwiftUI

/// Compact brand marks for agents and upstream providers.
///
/// Real vendor wordmarks are trademarked and awkward to ship as assets from
/// Command Line Tools builds, so these are SF Symbol badges tinted to read as
/// Anthropic / OpenAI / GitHub / Kong / Bedrock at a glance.
struct BrandMark: View {
    enum Kind {
        case agent(id: String, vendor: String?)
        case format(String)
        case provider(String?)
        case kong
    }

    let kind: Kind
    var size: CGFloat = 18

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(background)
            Image(systemName: symbol)
                .font(.system(size: size * 0.52, weight: .semibold))
                .foregroundStyle(foreground)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var symbol: String {
        switch kind {
        case .agent(let id, let vendor):
            return agentSymbol(id: id, vendor: vendor)
        case .format(let format):
            switch format.lowercased() {
            case "anthropic": return "sparkles"
            case "openai": return "circle.hexagongrid.fill"
            default: return "cube.fill"
            }
        case .provider(let name):
            return providerSymbol(name)
        case .kong:
            return "diamond.fill"
        }
    }

    private var background: Color {
        switch kind {
        case .agent(_, let vendor):
            return brandColor(vendor).opacity(0.18)
        case .format(let format):
            return formatColor(format).opacity(0.18)
        case .provider(let name):
            return providerColor(name).opacity(0.18)
        case .kong:
            return Color(red: 0.09, green: 0.45, blue: 0.83).opacity(0.18)
        }
    }

    private var foreground: Color {
        switch kind {
        case .agent(_, let vendor):
            return brandColor(vendor)
        case .format(let format):
            return formatColor(format)
        case .provider(let name):
            return providerColor(name)
        case .kong:
            return Color(red: 0.09, green: 0.45, blue: 0.83)
        }
    }

    private func agentSymbol(id: String, vendor: String?) -> String {
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
    }

    private func providerSymbol(_ name: String?) -> String {
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
    }

    private func brandColor(_ vendor: String?) -> Color {
        switch vendor {
        case "anthropic": return Color(red: 0.85, green: 0.45, blue: 0.22) // warm clay
        case "openai": return Color(red: 0.10, green: 0.65, blue: 0.50)
        case "github": return Color(red: 0.35, green: 0.25, blue: 0.75)
        case "kong": return Color(red: 0.09, green: 0.45, blue: 0.83)
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
