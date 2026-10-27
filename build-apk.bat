@echo off
setlocal
cd /d "%~dp0"
set "SDK=C:\Users\91596\AppData\Local\android-sdk-tmp"
set "BT=%SDK%\bt\android-14"
set "AJAR=%SDK%\plat\android-34\android.jar"
set "JDK=%SDK%\jdk\jdk-17.0.20.1+1"
set "PATH=%JDK%\bin;%PATH%"

echo [0/6] prepare flat assets...
python prepare-assets.py || goto :err
echo [1/6] aapt2 compile...
if exist build rmdir /s /q build
mkdir build
call "%BT%\aapt2.exe" compile --dir android\res -o build\res.zip || goto :err

echo [2/6] aapt2 link...
call "%BT%\aapt2.exe" link -o build\base.apk -I "%AJAR%" --manifest android\AndroidManifest.xml --min-sdk-version 21 --target-sdk-version 34 -A android/assets-flat build\res.zip --auto-add-overlay || goto :err

echo [3/6] javac...
mkdir build\classes
dir /s /b android\*.java > build\sources.txt
"%JDK%\bin\javac.exe" -encoding utf-8 -source 11 -target 11 -classpath "%AJAR%" -d build\classes @build\sources.txt || goto :err

echo [4/6] d8 dex...
"%JDK%\bin\jar.exe" cf build\classes.jar -C build\classes . || goto :err
call "%BT%\d8.bat" --release --lib "%AJAR%" --output build build\classes.jar || goto :err
if not exist build\classes.dex goto :err

echo [5/6] pack dex + zipalign...
copy /y build\base.apk build\withdex.apk >nul
cd build
"%JDK%\bin\jar.exe" uf withdex.apk classes.dex || goto :err
"%BT%\zipalign.exe" -f -p 4 withdex.apk aligned.apk || goto :err
cd ..

echo [6/6] apksigner sign...
rem 使用仓库根目录的持久签名文件 tv-debug.keystore(build 目录会被清空,不能把 keystore 放里面)
if not exist tv-debug.keystore "%JDK%\bin\keytool.exe" -genkeypair -keystore tv-debug.keystore -storepass android -keypass android -alias tv -dname "CN=yingshi" -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 2>nul
call "%BT%\apksigner.bat" sign --ks tv-debug.keystore --ks-pass pass:android --out yingshi-tv.apk build\aligned.apk || goto :err
call "%BT%\apksigner.bat" verify yingshi-tv.apk && echo [OK] APK built: yingshi-tv.apk
copy /y yingshi-tv.apk amutv.apk >nul
echo [OK] APK copied: amutv.apk
exit /b 0
:err
echo [BUILD FAILED]
exit /b 1
