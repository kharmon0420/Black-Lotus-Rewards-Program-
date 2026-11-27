import Foundation
import Security
import SwiftUI

/// Tiny Keychain wrapper so the app key is not stored in plain preferences.
enum Keychain {
    private static let service = "com.blacklotus.rewards"

    static func get(_ account: String) -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return "" }
        return s
    }

    static func set(_ account: String, _ value: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: service,
                                   kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}

@MainActor
final class AppStore: ObservableObject {
    static let defaultServer = "https://black-lotus-rewards-n6a5.onrender.com"

    @Published var serverURL: String { didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") } }
    @Published var appKey: String { didSet { Keychain.set("appKey", appKey) } }
    @Published var config: AppConfig?

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? Self.defaultServer
        appKey = Keychain.get("appKey")
    }

    var api: RewardsAPI { RewardsAPI(baseURL: serverURL, appKey: appKey) }
    var isConfigured: Bool { !appKey.isEmpty }

    func loadConfig() async {
        config = try? await api.config()
    }
}
