# PowerShell script to create TWA project structure
$projectDir = "$env:USERPROFILE\Desktop\volleyball-twa"
$packageName = "ir.pouriaabedi.volleyballclub"
$appName = "Volleyball Club Manager"
$hostName = "pouriaabedi0073-sys.github.io"

# Create project directory
New-Item -ItemType Directory -Force -Path $projectDir

# Create gradle wrapper files
@"
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.0-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
"@ | Out-File -FilePath "$projectDir\gradle\wrapper\gradle-wrapper.properties" -Encoding UTF8

# Create build.gradle
@"
plugins {
    id 'com.android.application'
}

android {
    namespace '$packageName'
    compileSdk 34

    defaultConfig {
        applicationId "$packageName"
        minSdk 19
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation 'androidx.browser:browser:1.6.0'
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.google.androidbrowserhelper:androidbrowserhelper:2.5.0'
}
"@ | Out-File -FilePath "$projectDir\app\build.gradle" -Encoding UTF8

# Create AndroidManifest.xml
@"
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="$appName"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.NoActionBar">
        
        <meta-data
            android:name="asset_statements"
            android:resource="@string/asset_statements" />
            
        <activity android:name="com.google.androidbrowserhelper.trusted.LauncherActivity"
            android:exported="true">
            <meta-data android:name="android.support.customtabs.trusted.DEFAULT_URL"
                android:value="https://$hostName/volleyball-club/" />
                
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW"/>
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE"/>
                <data android:scheme="https"
                    android:host="$hostName"
                    android:pathPrefix="/volleyball-club/"/>
            </intent-filter>
        </activity>
    </application>
</manifest>
"@ | Out-File -FilePath "$projectDir\app\src\main\AndroidManifest.xml" -Encoding UTF8

# Create strings.xml with asset statements
$assetStatements = @"
[{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
        "namespace": "android_app",
        "package_name": "$packageName",
        "sha256_cert_fingerprints": ["D7:96:84:D3:4C:00:6A:C6:C9:EA:1F:8F:BC:D2:39:E6:9E:D8:6A:AC:E4:B0:32:47:1E:83:90:79:A5:C3:C7:38"]
    }
}]
"@

@"
<resources>
    <string name="app_name">$appName</string>
    <string name="asset_statements">$assetStatements</string>
</resources>
"@ | Out-File -FilePath "$projectDir\app\src\main\res\values\strings.xml" -Encoding UTF8

Write-Host "TWA project structure created at: $projectDir"
Write-Host "Next steps:"
Write-Host "1. Open the project in Android Studio"
Write-Host "2. Sync project with Gradle files"
Write-Host "3. Build the APK using your keystore"
Write-Host "   Key store path: $env:USERPROFILE\volleyballclub.keystore"
Write-Host "   Key alias: volleyballclub"
Write-Host "4. Test the APK and upload to Play Console"