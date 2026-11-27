import SwiftUI

// MARK: - Balance + rewards

struct MemberView: View {
    @EnvironmentObject var store: AppStore
    let result: LookupResult
    let phone: String
    var onDone: () -> Void
    var onChanged: (LookupResult) -> Void
    @State private var showRedeem = false
    @State private var showBirthday = false

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

                if result.birthdaySet == false {
                    Button { showBirthday = true } label: {
                        HStack {
                            Image(systemName: "gift.fill")
                            Text("Add your birthday for \(result.birthdayBonus ?? store.config?.birthdayBonus ?? 100) bonus points")
                                .multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .font(.headline).padding(16)
                        .background(Theme.accent.opacity(0.25))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }.buttonStyle(.plain)
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

                let canRedeem = tiers.contains { $0.points <= points }
                if canRedeem {
                    Button("Redeem a reward") { showRedeem = true }.buttonStyle(BigButtonStyle())
                    Button("Done", action: onDone).buttonStyle(BigButtonStyle(prominent: false))
                } else {
                    Button("Done", action: onDone).buttonStyle(BigButtonStyle())
                }
            }
            .padding(.top, 8)
        }
        .sheet(isPresented: $showRedeem) {
            RedeemSheet(phone: phone, points: points, tiers: tiers) { updated in
                onChanged(LookupResult(status: "member", firstName: result.firstName, points: updated.pointsLeft,
                                       bonusPending: result.bonusPending, signupBonus: result.signupBonus,
                                       birthdaySet: result.birthdaySet, birthdayBonus: result.birthdayBonus,
                                       tiers: updated.tiers ?? result.tiers))
            }
        }
        .sheet(isPresented: $showBirthday) {
            BirthdaySheet(phone: phone, bonus: result.birthdayBonus ?? store.config?.birthdayBonus ?? 100) {
                onChanged(LookupResult(status: "member", firstName: result.firstName, points: result.points,
                                       bonusPending: result.bonusPending, signupBonus: result.signupBonus,
                                       birthdaySet: true, birthdayBonus: result.birthdayBonus,
                                       tiers: result.tiers))
            }
        }
    }
}

// MARK: - Redeem (customer)

struct RedeemSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let phone: String
    let points: Int
    let tiers: [Tier]
    var onRedeemed: (RedeemResult) -> Void

    @State private var pending: Tier?                  // reward waiting for "Yes, redeem"
    @State private var attemptId = UUID().uuidString   // reused on retry so credit is never issued twice
    @State private var busy = false
    @State private var error: String?
    @State private var done: RedeemResult?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let done {
                        Image(systemName: "checkmark.seal.fill").font(.system(size: 64)).foregroundColor(Theme.accent)
                        Text("\(creditText(done.credit)) store credit added!")
                            .font(.title.weight(.bold)).multilineTextAlignment(.center)
                        Text("Tell the cashier you'd like to use your Store Credit.")
                            .font(.title3).multilineTextAlignment(.center).foregroundColor(.white.opacity(0.85))
                        Text("\(done.pointsLeft ?? 0) points left").foregroundColor(.white.opacity(0.6))
                        Button("Done") { dismiss() }.buttonStyle(BigButtonStyle())
                    } else {
                        Text("You have \(points) points").font(.title2)
                        Text("Choose a reward").foregroundColor(.white.opacity(0.7))
                        ForEach(tiers.filter { $0.points <= points }) { t in
                            Button {
                                if pending?.points != t.points { attemptId = UUID().uuidString }
                                error = nil
                                pending = t
                            } label: {
                                HStack {
                                    Text("\(t.points) points"); Spacer(); Text("\(t.creditText) off").bold()
                                }
                                .font(.title2).padding(20)
                                .background(pending?.points == t.points ? Theme.accent.opacity(0.35) : Theme.card)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                            }.buttonStyle(.plain).disabled(busy)
                        }

                        if let error { Text(error).foregroundColor(.red).multilineTextAlignment(.center) }

                        if let pending {
                            Text("Use \(pending.points) points for \(pending.creditText) off? This can't be undone.")
                                .multilineTextAlignment(.center).padding(.top, 8)
                            Button(busy ? "Working…" : "Yes, redeem") { Task { await redeem(pending) } }
                                .buttonStyle(BigButtonStyle(enabled: !busy)).disabled(busy)
                        }
                    }
                }
                .padding(24)
                .frame(maxWidth: 560)
            }
            .navigationTitle("Redeem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if done == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(busy || done != nil)
    }

    private func creditText(_ c: Double?) -> String {
        guard let c else { return "$0" }
        return c == c.rounded() ? "$\(Int(c))" : String(format: "$%.2f", c)
    }

    private func redeem(_ tier: Tier) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let r = try await store.api.redeem(phone: phone, points: tier.points, clientId: attemptId)
            switch r.status {
            case "redeemed": done = r; onRedeemed(r)
            case "insufficient_points": error = "Not enough points."
            case "failed_earlier": attemptId = UUID().uuidString; error = "That didn't go through. Tap redeem to try again."
            case "lightspeed_error": error = "We couldn't add the credit just now. Tap redeem to try again; your points won't be used twice."
            default: error = "Couldn't redeem (\(r.status)). Please ask a team member."
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
    @State private var bMonth = 0
    @State private var bDay = 0
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

 Text("Birthday (optional): get \(store.config?.birthdayBonus ?? 100) bonus points in your birthday month")
                    .font(.callout).foregroundColor(.white.opacity(0.75)).multilineTextAlignment(.center).padding(.top, 4)
                BirthdayFields(month: $bMonth, day: $bDay)

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
                                               email: email.trimmingCharacters(in: .whitespaces),
                                               birthMonth: bMonth, birthDay: bDay)
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

// MARK: - Birthday

struct BirthdayFields: View {
    @Binding var month: Int
    @Binding var day: Int
    private let months = Calendar.current.monthSymbols
    private let maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    var body: some View {
        HStack(spacing: 12) {
            Picker("Month", selection: $month) {
                Text("Month").tag(0)
                ForEach(1...12, id: \.self) { Text(months[$0 - 1]).tag($0) }
            }
            Picker("Day", selection: $day) {
                Text("Day").tag(0)
                ForEach(1...(month == 0 ? 31 : maxDays[month - 1]), id: \.self) { Text("\($0)").tag($0) }
            }
        }
        .pickerStyle(.menu)
        .frame(maxWidth: .infinity)
        .padding(8)
        .background(Theme.card).clipShape(RoundedRectangle(cornerRadius: 12))
        .onChange(of: month) { _ in
            if month > 0 && day > maxDays[month - 1] { day = 0 }
        }
    }
}

struct BirthdaySheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let phone: String
    let bonus: Int
    var onSaved: () -> Void

    @State private var month = 0
    @State private var day = 0
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Image(systemName: "gift.fill").font(.system(size: 52)).foregroundColor(Theme.accent)
                Text("Get \(bonus) bonus points in your birthday month")
                    .font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                Text("We only need the month and day. It can't be changed later.")
                    .foregroundColor(.white.opacity(0.7)).multilineTextAlignment(.center)
                BirthdayFields(month: $month, day: $day)
                if let error { Text(error).foregroundColor(.red).multilineTextAlignment(.center) }
                Button(busy ? "Saving…" : "Save birthday") { Task { await save() } }
                    .buttonStyle(BigButtonStyle(enabled: month > 0 && day > 0 && !busy))
                    .disabled(month == 0 || day == 0 || busy)
                Spacer()
            }
            .padding(24).frame(maxWidth: 560)
            .navigationTitle("Birthday").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
    }

    private func save() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let r = try await store.api.setBirthday(phone: phone, month: month, day: day)
            switch r.status {
            case "saved", "already_set": onSaved(); dismiss()
            case "invalid_birthday": error = "That date doesn't look right."
            default: error = "Couldn't save (\(r.status))."
            }
        } catch { self.error = error.localizedDescription }
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
