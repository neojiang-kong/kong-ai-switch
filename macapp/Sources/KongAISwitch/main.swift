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
            // A glyph that reads at menu bar size in both light and dark.
            Image(systemName: "arrow.triangle.branch")
        }
        .menuBarExtraStyle(.window)
    }
}
