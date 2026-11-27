import Foundation

struct Tier: Codable, Identifiable, Hashable {
    let points: Int
    let credit: Double
    let available: Bool?
    var id: Int { points }

    var creditText: String {
        credit == credit.rounded() ? "$\(Int(credit))" : String(format: "$%.2f", credit)
    }
}

struct AppConfig: Codable {
    let pointsPerDollar: Int
    let signupBonus: Int
    let tiers: [Tier]
}

/// Response of GET /api/member
struct LookupResult: Codable {
    let status: String          // member | existing_customer | new | invalid_phone
    let firstName: String?
    let points: Int?
    let bonusPending: Bool?
    let signupBonus: Int?
    let tiers: [Tier]?
}

/// Response of POST /api/signup
struct SignupResult: Codable {
    let status: String          // signed_up | already_member | invalid_phone | missing_name
    let linkedExisting: Bool?
    let signupBonus: Int?
    let bonusPending: Bool?
}

/// Response of POST /api/redeem
struct RedeemResult: Codable {
    let status: String          // redeemed | insufficient_points | lightspeed_error | ...
    let credit: Double?
    let pointsLeft: Int?
    let tiers: [Tier]?
    let message: String?
}

enum PhoneFormat {
    static func digits(_ s: String) -> String { s.filter(\.isNumber) }

    static func pretty(_ digits: String) -> String {
        let d = Array(digits.prefix(10))
        var out = ""
        for (i, c) in d.enumerated() {
            if i == 0 { out += "(" }
            if i == 3 { out += ") " }
            if i == 6 { out += "-" }
            out.append(c)
        }
        return out.isEmpty ? "(___) ___-____" : out
    }
}
