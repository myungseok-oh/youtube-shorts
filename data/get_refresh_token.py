"""YouTube OAuth Refresh Token 발급 스크립트.

실행: python data/get_refresh_token.py
브라우저에서 Google 로그인 후 권한 승인하면 Refresh Token이 출력됩니다.
"""
from google_auth_oauthlib.flow import InstalledAppFlow

CLIENT_SECRET_FILE = "data/client_secret_313980281486-mlkn36o55ds8lhjfkroimahcr48qfu1d.apps.googleusercontent.com.json"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def main():
    flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET_FILE, SCOPES)
    credentials = flow.run_local_server(port=8090, prompt="consent",
                                        access_type="offline")
    print("\n=== Refresh Token ===")
    print(credentials.refresh_token)
    print("\n이 토큰을 대시보드 채널 설정의 YouTube Refresh Token에 입력하세요.")


if __name__ == "__main__":
    main()
