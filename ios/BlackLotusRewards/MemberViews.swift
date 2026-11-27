import SwiftUI

// MARK: - Balance + rewards

struct MemberView: View {
    @EnvironmentObject var store: AppStore
    let result: LookupResult
    let phone: String
    var onDone: () -> Void
    var onChanged: (LookupResult) -> Void
    @State private var showRedeem = false

    private var points: Int { result.points ?? 0 }
    private var tiers: [Tier] { result.tiers ?? store.config?.tiers ?? [] }
    private var next: Tier? { tiers.first { points < $0.points } }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("Welcome back\(result.firstName.map { ", \($0)" } ?? "")")
                    .font(.title).foregroundColor(.white.opacity(0.9)).padding(.top, 12)

                VStack(spacing: 4) {
                    Text("\(points)").font(.system(size: 80, weight: .bold, design: .rounded))
                    Text("points").font(.title3).foregroundColor(.white.opacity(0.7))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 20)
                .background(Theme.card).clipShape(RoundedRectangle(cornerRadius: 20))

                if result.bonusPending == true {
                    Text("Your \(result.signupBonus ?? store.config?.signupBonus ?? 100) welcome points are added after your next purchase.")
                        .multilineTextAlignment(.center).foregroundColor(Theme.accent)
                }

                if let next {
                    Text("\(next.points - points) more points for \(next.creditText) off")
                        .font(.headline).foregroundColor(.white.opacity(0.85))
                } else if !tiers.isEmpty {
                    Text("You've unlocked every reward!").font(.headline).foregroundColor(Theme.accent)
                }

                VStack(spacing: 8) {
                    ForEach(tiers) { t in
                        let ok = points >= t.points
                        HStack {
                            Image(systemName: ok ? "checkmark.circle.fill" : "circle")
                                .foregroundColor(ok ? Theme.accent : .white.opacity(0.3))
                            Text("\(t.points) points").font(.title3)
                            Spacer()
                            Text("\(t.creditText) off").font(.title3.weight(.semibold))
                        }
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .background(Theme.card).clipShape(RoundedRectangle(cornerRadius: 14))
                        .opacity(ok ? 1 : 0.5)
                    }
                }

                Text("Ask the cashier to apply your reward at checkout.")
                    .font(.callout).foregroundColor(.white.opacity(0.6)).multilineTextAlignment(.center)

                Button("Done", action: onDone).buttonStyle(BigButtonStyle())
                Button("Staff: apply a reward") { showRedeem = true }
                    .buttonStyle(BigButtonStyle(prominent: false))
            }
            .padding(.top, 8)
        }
        .sheet(isPresented: $showRedeem) {
            RedeemSheet(phone: phone, points: points, tiers: tiers) { updated in
                onChanged(LookupResult(status: "member", firstName: result.firstName, points: updated.pointsLeft,
                                       bonusPending: result.bonusPending, signupBonus: result.signupBonus,
                                       tiers: updated.tiers ?? result.tiers))
            }
        }
    }
}

// MARK: - Staff redeem

struct RedeemSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let phone: String
    let points: Int
    let tiers: [Tier]
    var onRedeemed: (RedeemResult) -> Void

    @State private var pin = ""
    @State private var selected: Tier?
    @State private var attemptId = UUID().uuidString   // reused on retry so credit is never issued twice
    @State private var busy = false
    @State private var error: String?
    @State private var done: RedeemResult?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if let done {
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 64)).foregroundColor(Theme.accent)
                    Text("\(creditText(done.credit)) store credit added")
                        .font(.title.weight(.bold))
                    Text("Take \"Store Credit\" as payment at the register.")
                        .multilineTextAlignment(.center).foregroundColor(.white.opacity(0.8))
                    Text("\(done.pointsLeft ?? 0) points left").foregroundColor(.white.opacity(0.6))
                    Button("Done") { dismiss() }.buttonStyle(BigButtonStyle())
                } else {
                    Text("Staff PIN").font(.headline)
                    SecureField("PIN", text: $pin)
                        .keyboardType(.numberPad).textContentType(.oneTimeCode)
                        .multilineTextAlignment(.center).font(.title)
                        .padding().background(Theme.card).clipShape(RoundedRectangle(cornerRadius: 12))

                    Text("Choose a reward (\(points) points)").font(.headline).padding(.top, 8)
                    let available = tiers.filter { $0.points <= points }
                    if available.isEmpty {
                        Text("Not enough points yet.").foregroundColor(.white.opacity(0.6))
                    }
                    ForEach(available) { t in
                        Button {
                            if selected?.points != t.points { attemptId = UUID().uuidString }
                            selected = t
                        } label: {
                            HStack {
                                Text("\(t.points) points"); Spacer(); Text("\(t.creditText) off").bold()
                                if selected?.points == t.points { Image(systemName: "checkmark") }
                            }
                            .font(.title3).padding()
                            .background(selected?.points == t.points ? Theme.accent.opacity(0.35) : Theme.card)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain)
                    }

                    if let error { Text(error).foregroundColor(.red).multilineTextAlignment(.center) }

                    Button(busy ? "Working…" : confirmTitle) { Task { await redeem() } }
                        .buttonStyle(BigButtonStyle(enabled: canConfirm))
                        .disabled(!canConfirm)
                }
                Spacer()
            }
            .padding(24)
            .frame(maxWidth: 560)
            .navigationTitle("Apply reward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if done == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(busy)
    }

    private var canConfirm: Bool { selected != nil && pin.count >= 4 && !busy }
    private var confirmTitle: String { selected.map { "Apply \($0.creditText) off" } ?? "Apply reward" }
    private func creditText(_ c: Double?) -> String {
        guard let c else { return "$0" }
        return c == c.rounded() ? "$\(Int(c))" : String(format: "$%.2f", c)
    }

    private func redeem() async {
        guard let selected else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let r = try await store.api.redeem(phone: phone, points: selected.points, clientId: attemptId, staffPin: pin)
            switch r.status {
            case "redeemed": done = r; onRedeemed(r)
            case "insufficient_points": error = "Not enough points."
            case "failed_earlier": attemptId = UUID().uuidString; error = "That attempt failed. Tap apply to try again."
            case "lightspeed_error": error = "Lightspeed couldn't add the credit. Tap apply to try again; it won't use the points twice."
            default: error = "Couldn't apply the reward (\(r.status))."
            }
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Join

struct JoinView: View {
    @EnvironmentObject var store: AppStore
    let phone: String
    let firstName: String
    let existing: Bool
    var onDone: () -> Void
    var onSignedUp: (SignupResult) -> Void

    @State private var first = ""
    @State private var last = ""
    @State private var email = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    enum Field { case first, last, email }

    private var bonus: Int { store.config?.signupBonus ?? 100 }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Text(existing ? "We found you!" : "Join Black Lotus Rewards")
                    .font(.largeTitle.weight(.bold)).padding(.top, 12)
                Text(existing
                     ? "Join rewards with \(PhoneFormat.pretty(phone)). Earn 2 points for every dollar."
                     : "Earn 2 points for every dollar, plus \(bonus) bonus points after your first purchase.")
                    .multilineTextAlignment(.center).foregroundColor(.white.opacity(0.8))

                field("First name", $first, .first).textContentType(.givenName)
                field("Last name (optional)", $last, .last).textContentType(.familyName)
                field("Email (optional)", $email, .email).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()

                if let error { Text(error).foregroundColor(.red).multilineTextAlignment(.center) }

                Button(busy ? "Joining…" : "Join now") { Task { await join() } }
                    .buttonStyle(BigButtonStyle(enabled: !first.trimmingCharacters(in: .whitespaces).isEmpty && !busy))
                    .disabled(first.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                Button("Not now", action: onDone).buttonStyle(BigButtonStyle(prominent: false))
            }
        }
        .onAppear { first = firstName }
    }

    private func field(_ title: String, _ text: Binding<String>, _ f: Field) -> some View {
        TextField(title, text: text)
            .focused($focus, equals: f)
            .font(.title3).padding()
            .background(Theme.card).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func join() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let r = try await store.api.signup(phone: phone,
                                               firstName: first.trimmingCharacters(in: .whitespaces),
                                               lastName: last.trimmingCharacters(in: .whitespaces),
                                               email: email.trimmingCharacters(in: .whitespaces))
            switch r.status {
            case "signed_up", "already_member": onSignedUp(r)
            case "missing_name": error = "Please enter your first name."
            case "invalid_phone": error = "That phone number doesn't look right."
            default: error = "Couldn't sign you up (\(r.status))."
            }
        } catch { self.error = error.localizedDescription }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var store: AppStore
    let result: SignupResult
    var onDone: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark.circle.fill").font(.system(size: 72)).foregroundColor(Theme.accent)
            Text(result.status == "already_member" ? "You're already in!" : "You're in!")
                .font(.largeTitle.weight(.bold))
            if result.status == "signed_up" {
                Text("Your \(result.signupBonus ?? store.config?.signupBonus ?? 100) bonus points will be added after your first purchase.")
                    .font(.title3).multilineTextAlignment(.center).foregroundColor(.white.opacity(0.85))
            }
            Spacer()
            Button("Done", action: onDone).buttonStyle(BigButtonStyle())
        }
    }
}

// MARK: - Settings (long-press the logo for 3 seconds)

struct SettingsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let firstRun: Bool
    @State private var server = ""
    @State private var key = ""

    var body: some View {
        NavigationStack {
            Form {
                Section(footer: Text("Enter the APP_KEY from the Render environment settings.")) {
                    TextField("Server address", text: $server)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("App key", text: $key)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Button("Save") {
                    store.serverURL = server.trimmingCharacters(in: .whitespaces)
                    store.appKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task { await store.loadConfig() }
                    if !firstRun { dismiss() }
                }.disabled(key.isEmpty || server.isEmpty)
            }
            .navigationTitle(firstRun ? "Set up this iPad" : "Settings")
            .toolbar {
                if !firstRun { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            }
        }
        .onAppear { server = store.serverURL; key = store.appKey }
        .preferredColorScheme(.dark)
    }
}
