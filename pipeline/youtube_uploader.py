"""YouTube Data API v3 업로더 — Resumable upload"""
from __future__ import annotations
import os
import httplib2
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials


YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload"
YOUTUBE_API_SERVICE = "youtube"
YOUTUBE_API_VERSION = "v3"


def _get_authenticated_service(client_id: str, client_secret: str,
                               refresh_token: str):
    """Refresh Token으로 인증된 YouTube 서비스 객체 생성."""
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
    )
    return build(YOUTUBE_API_SERVICE, YOUTUBE_API_VERSION, credentials=creds)


def upload_video(
    video_path: str,
    title: str,
    description: str,
    tags: list[str],
    client_id: str,
    client_secret: str,
    refresh_token: str,
    privacy_status: str = "private",
    thumbnail_path: str = "",
) -> dict:
    """YouTube에 영상을 업로드하고 video_id와 URL을 반환.

    Returns:
        {"video_id": "...", "url": "https://youtube.com/shorts/..."}
    """
    youtube = _get_authenticated_service(client_id, client_secret, refresh_token)

    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": "22",  # People & Blogs
        },
        "status": {
            "privacyStatus": privacy_status,
            "selfDeclaredMadeForKids": False,
        },
    }

    media = MediaFileUpload(
        video_path,
        mimetype="video/mp4",
        resumable=True,
        chunksize=10 * 1024 * 1024,  # 10MB chunks
    )

    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media,
    )

    response = None
    while response is None:
        _, response = request.next_chunk()

    video_id = response["id"]

    # 썸네일 업로드 (thumbnail_path가 있으면)
    if thumbnail_path and os.path.isfile(thumbnail_path):
        try:
            mime = "image/jpeg" if thumbnail_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
            thumb_media = MediaFileUpload(thumbnail_path, mimetype=mime)
            youtube.thumbnails().set(
                videoId=video_id,
                media_body=thumb_media,
            ).execute()
        except Exception as e:
            print(f"[youtube] 썸네일 업로드 실패 (무시): {e}")

    return {
        "video_id": video_id,
        "url": f"https://youtube.com/shorts/{video_id}",
    }


