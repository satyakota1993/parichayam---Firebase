# Parichayam Firebase Functions

This folder contains the secure MSG91 verification endpoint used by the auth page.

## Why this exists

MSG91's OTP widget returns an access token after OTP verification. That token should be verified on the server before you trust the login or mark a signup phone number as verified.

## Required environment variables

Copy `.env.example` to `.env` and fill:

- `MSG91_VERIFY_URL`
  The official MSG91 "Verify Access Token" endpoint from your dashboard/docs.
- `MSG91_AUTH_KEY`
  Your private MSG91 auth key. Never expose this in the browser or admin page.
- `MSG91_ALLOWED_ORIGINS`
  Comma-separated list of web origins allowed to call this function.

## Install

```powershell
cd "D:\Parichayam\24.3.2026\Parichayam\2026-03-29_firebase-ready\functions"
npm.cmd install
```

## Deploy

```powershell
cd "D:\Parichayam\24.3.2026\Parichayam\2026-03-29_firebase-ready"
firebase.cmd deploy --only functions
```

## After deploy

1. Copy the deployed function URL for `msg91VerifyAccessToken`
2. Paste that URL into `Admin -> Website Content -> MSG91 Mobile Authentication -> Verify Endpoint`
3. Save the auth settings
4. Test mobile OTP login/signup from `/auth`

## Important

If MSG91 expects a different request header or payload shape for the access-token verification endpoint, update `verifyMsg91AccessTokenWithProvider()` in `index.js` to match your account's official documentation.
