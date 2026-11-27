import SwiftUI

enum Screen: Equatable {
    case entry
    case member(LookupResult, phone: String)
    case join(phone: String, firstName: String, existing: Bool)
    case welcome(SignupResult)

    static func == (a: Screen, b: Screen) -> Bool {
        switch (a, b) {
        case (.entry, .entry): return true
        case (.member(_, let p1), .member(_, let p2)): return p1 == p2
        case (.join(let p1, _, _), .join(let p2, _, _)): return p1 == p2
        case (.welcome, .welcome): return true
        default: return false
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: AppStore
    @State private var screen: Screen = .entry
    @State private var showSettings = false
    @State private var resetTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if !store.isConfigured {
                SettingsView(firstRun: true)
            } else {
                VStack(spacing: 0) {
                    LogoView(height: 110)
                        .padding(.top, 24)
                        .onLongPressGesture(minimumDuration: 3) { showSettings = true }
                    content
                        .frame(maxWidth: 640)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 24)
                }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView(firstRun: false) }
        .task { await store.loadConfig() }
        .onChange(of: screen) { _ in scheduleReset() }
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case .entry:
            EntryView(onResult: { result, phone in route(result, phone) })
        case .member(let r, let phone):
            MemberView(result: r, phone: phone, onDone: reset, onChanged: { updated in
                screen = .member(updated, phone: phone)
            })
        case .join(let phone, let name, let existing):
            JoinView(phone: phone, firstName: name, existing: existing, onDone: reset) { res in
                screen = .welcome(res)
            }
        case .welcome(let r):
            WelcomeView(result: r, onDone: reset)
        }
    }

    private func route(_ r: LookupResult, _ phone: String) {
        switch r.status {
        case "member": screen = .member(r, phone: phone)
        case "existing_customer": screen = .join(phone: phone, firstName: r.firstName ?? "", existing: true)
        default: screen = .join(phone: phone, firstName: "", existing: false)
        }
    }

    private func reset() { screen = .entry }

    /// Back to the phone keypad after a while with no change, so the next customer starts fresh.
    private func scheduleReset() {
        resetTask?.cancel()
        guard screen != .entry else { return }
        let seconds: UInt64 = { if case .join = screen { return 120 } else { return 45 } }()
        resetTask = Task {
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            if !Task.isCancelled { screen = .entry }
        }
    }
}

// MARK: - Phone keypad

struct EntryView: View {
    @EnvironmentObject var store: AppStore
    var onResult: (LookupResult, String) -> Void
    @State private var digits = ""
    @State private var loading = false
    @State private var error: String?

    private let keys = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "⌫"]]

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)
            Text("Enter your phone number").font(.title2).foregroundColor(.white.opacity(0.8))
            Text(PhoneFormat.pretty(digits))
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .foregroundColor(digits.isEmpty ? .white.opacity(0.3) : .white)
                .minimumScaleFactor(0.6).lineLimit(1)
            if let error { Text(error).foregroundColor(.red).multilineTextAlignment(.center) }

            VStack(spacing: 12) {
                ForEach(keys, id: \.self) { row in
                    HStack(spacing: 12) {
                        ForEach(row, id: \.self) { k in
                            if k.isEmpty { Color.clear.frame(maxWidth: .infinity, minHeight: 76) }
                            else {
                                Button { tap(k) } label: {
                                    Text(k).font(.system(size: 32, weight: .medium))
                                        .frame(maxWidth: .infinity, minHeight: 76)
                                        .background(Theme.card)
                                        .clipShape(RoundedRectangle(cornerRadius: 16))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
            }

            Button(loading ? "Looking you up…" : "Check my points") { Task { await look() } }
                .buttonStyle(BigButtonStyle(enabled: digits.count == 10 && !loading))
                .disabled(digits.count != 10 || loading)
            Spacer(minLength: 0)
        }
    }

    private func tap(_ k: String) {
        error = nil
        if k == "⌫" { _ = digits.popLast() }
        else if digits.count < 10 { digits.append(k) }
    }

    private func look() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let r = try await store.api.lookup(phone: digits)
            if r.status == "invalid_phone" { error = "That doesn't look like a valid phone number." }
            else { onResult(r, digits) }
        } catch { self.error = error.localizedDescription }
    }
}
