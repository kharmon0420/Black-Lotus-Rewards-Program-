import SwiftUI

@main
struct BlackLotusRewardsApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }
}

enum Theme {
    static let accent = Color(red: 0.80, green: 0.68, blue: 1.0)
    static let card = Color.white.opacity(0.08)
}

/// The logo shown across the app: lotus + "BLACK LOTUS" only.
struct LogoView: View {
    var height: CGFloat = 120
    var body: some View {
        Image("Logo").resizable().scaledToFit().frame(height: height)
            .accessibilityLabel("Black Lotus")
    }
}

struct BigButtonStyle: ButtonStyle {
    var prominent = true
    var enabled = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title2.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(prominent ? Theme.accent : Theme.card)
            .foregroundColor(prominent ? .black : .white)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)
    }
}
