import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case server(String)
    case network

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "The app is not set up yet."
        case .server(let m): return m
        case .network: return "Can't reach the rewards server. Check the Wi-Fi and try again."
        }
    }
}

struct RewardsAPI {
    let baseURL: String
    let appKey: String

    private func makeRequest(_ path: String, method: String, query: [URLQueryItem], body: [String: Any]?, extra: [String: String]) throws -> URLRequest {
        guard !appKey.isEmpty, var comps = URLComponents(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + path) else {
            throw APIError.notConfigured
        }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw APIError.notConfigured }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue(appKey, forHTTPHeaderField: "x-app-key")
        for (k, v) in extra { req.setValue(v, forHTTPHeaderField: k) }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    private func send<T: Decodable>(_ path: String, method: String = "GET", query: [URLQueryItem] = [],
                                    body: [String: Any]? = nil, extra: [String: String] = [:]) async throws -> T {
        let req = try makeRequest(path, method: method, query: query, body: body, extra: extra)
        let data: Data, resp: URLResponse
        do { (data, resp) = try await URLSession.shared.data(for: req) } catch { throw APIError.network }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200 {
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw APIError.server("Unexpected reply from the server.") }
        }
        if code == 401 { throw APIError.server("This iPad's app key was rejected. Re-enter it in Settings.") }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let m = obj["error"] as? String {
            throw APIError.server(m.prefix(1).uppercased() + m.dropFirst())
        }
        throw APIError.server("Server error (\(code)). Try again.")
    }

    func config() async throws -> AppConfig {
        try await send("/api/config")
    }

    func lookup(phone: String) async throws -> LookupResult {
        try await send("/api/member", query: [URLQueryItem(name: "phone", value: phone)])
    }

    func signup(phone: String, firstName: String, lastName: String, email: String) async throws -> SignupResult {
        var body: [String: Any] = ["phone": phone, "firstName": firstName]
        if !lastName.isEmpty { body["lastName"] = lastName }
        if !email.isEmpty { body["email"] = email }
        return try await send("/api/signup", method: "POST", body: body)
    }

    func redeem(phone: String, points: Int, clientId: String) async throws -> RedeemResult {
        try await send("/api/redeem", method: "POST",
                       body: ["phone": phone, "points": points, "clientId": clientId])
    }
}
