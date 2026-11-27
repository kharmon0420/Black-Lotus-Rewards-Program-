# Black Lotus Rewards: iPad app (SwiftUI)

Kiosk-style iPad app. Customers enter a phone number to see points, join, or redeem a reward.
Only the lotus and "BLACK LOTUS" appear in the app.

## Build it (on the Mac)
1. Install Xcode from the Mac App Store, open it once, accept the license.
2. Open Terminal and run: `brew install xcodegen` (get Homebrew from https://brew.sh if needed).
3. Download this repo (green **Code** button, **Download ZIP**, unzip), then in Terminal:
   `cd path/to/Black-Lotus-Rewards-Program--main/ios && xcodegen`
   This creates `BlackLotusRewards.xcodeproj`. Double-click it.
4. In Xcode, click the project (top of the left list), then **Signing & Capabilities**: tick *Automatically manage signing* and pick your Apple Developer team.
   If it says the bundle ID is taken, change `com.blacklotus.rewards` to something unique (for example `com.yourname.blacklotusrewards`).
5. Plug in the iPad (or pick an iPad simulator) and press Run to try it.

## Put it on TestFlight
1. At https://appstoreconnect.apple.com open **Apps**, **+**, **New App**: platform iOS, name "Black Lotus Rewards", the same bundle ID, any SKU.
2. In Xcode choose the destination **Any iOS Device (arm64)**, then **Product > Archive**.
3. When the Organizer opens: **Distribute App > App Store Connect > Upload**.
4. After processing (about 15 min), open the app in App Store Connect > **TestFlight**, add yourself as an internal tester, and install **TestFlight** on the iPad.

## First launch on the iPad
The app asks for the **App key**: copy `APP_KEY` from Render > Environment and type it in. The server address is already filled in.
To open Settings later, press and hold the logo for 3 seconds.

## Redeeming
The customer looks themselves up, taps **Redeem a reward**, picks a reward and confirms. The service adds Lightspeed store credit to their account; they tell the cashier, who takes "Store Credit" as payment.
No PIN is needed by default. To require a staff PIN on the server, set `REQUIRE_STAFF_PIN=true` in Render (the iPad app would then need a PIN field added).
