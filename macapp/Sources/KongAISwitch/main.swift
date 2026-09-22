import SwiftUI

/// Menu bar entry point.
///
/// `MenuBarExtra` with the `.window` style gives a real SwiftUI panel rather
/// than a list of menu items, which is what lets the model list scroll and
/// show two lines per row.
@main
struct KongAISwitchApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuView(state: state)
        } label: {
            // Icon plus text. A bare glyph is genuinely hard to find on a
            // wide display, where the menu bar can be several feet across.
            // The label also shows which model is active, so the common
            // question is answered without opening the panel at all.
            HStack(spacing: 3) {
                // Menu bar glyphs sit around 12pt; larger custom PNGs inflate the item.
                BrandMark(kind: .kong, size: 12)
                    .frame(width: 12, height: 12)
                Text(state.menuBarLabel)
            }
            .fixedSize()
        }
        .menuBarExtraStyle(.window)
    }
}
