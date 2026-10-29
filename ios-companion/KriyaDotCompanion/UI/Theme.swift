// SPDX-License-Identifier: Apache-2.0
import SwiftUI
import UIKit

/// App theme: dark, matching the Android companion's dark Material 3.
/// The accent color lives in Assets.xcassets/AccentColor.colorset.
enum KriyaDotTheme {
    static func apply() {
        // Keep tab/navigation bars consistent with the dark palette.
        let appearance = UINavigationBarAppearance()
        appearance.configureWithDefaultBackground()
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
    }
}
