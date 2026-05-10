import Foundation
import Security

/// Thin wrapper over Security.framework for storing the HA token + Hue
/// applicationKey under the shared service `copilot-lights`. Account names
/// match the env-var naming convention so config strings like
/// `keychain:HASS_TOKEN` resolve cleanly: service=copilot-lights,
/// account=HASS_TOKEN.
enum KeychainHelper {
    static let service = "copilot-lights"

    enum KeychainError: Error, LocalizedError {
        case unhandledStatus(OSStatus)
        case dataConversionFailed

        var errorDescription: String? {
            switch self {
            case .unhandledStatus(let s):
                return "Keychain error: OSStatus \(s) (\(SecCopyErrorMessageString(s, nil) as String? ?? "unknown"))"
            case .dataConversionFailed:
                return "Failed to encode/decode keychain value as UTF-8"
            }
        }
    }

    /// Returns nil when no entry exists for that account.
    static func read(account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unhandledStatus(status) }
        guard let data = item as? Data, let s = String(data: data, encoding: .utf8) else {
            throw KeychainError.dataConversionFailed
        }
        return s
    }

    /// Upsert: writes if missing, updates the data when present.
    static func write(account: String, value: String) throws {
        guard let data = value.data(using: .utf8) else { throw KeychainError.dataConversionFailed }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: data,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if updateStatus == errSecSuccess { return }
        if updateStatus == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.unhandledStatus(addStatus) }
            return
        }
        throw KeychainError.unhandledStatus(updateStatus)
    }

    static func delete(account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound || status == errSecSuccess { return }
        throw KeychainError.unhandledStatus(status)
    }
}
