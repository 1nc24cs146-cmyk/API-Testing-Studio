# Skill: API Collections

Status: Implemented in API Testing Studio v0.1.2 (sidebar webview, persisted in editor storage).

## When to use
When requests need to be saved, reused, and organised instead of retyped every time.

## Seeded collections (from the project spec)
- Authentication: Register, Login, Logout, Refresh Token, Get Current User, Reset Password, Verify Email
- Users: Get All, Get By ID, Create, Update (PUT), Update Partially (PATCH), Delete
- Products: Get Products, Get Product By ID, Create, Update, Delete, Search
- Orders: Get All, Get By ID, Create, Update, Cancel
- Payments: Create, Get, Verify, Refund (use mock/sandbox endpoints only while developing — never test against real payment systems without authorisation)
- File Upload: Upload, Get Uploaded File, Delete
- Custom: empty, for the developer's own requests

## How it works
1. Click a saved request to load it into the request builder.
2. Edit it, then Save to update it, Duplicate to copy it, or Delete to remove it.
3. Create a new collection with a name, then save requests into it.
4. Collections, requests, and history are stored locally in the editor's stored state — there is no cloud account and no sync in v0.1.2.

## Rules
- Do not overwrite a saved request without the user asking to save.
- Do not delete a collection or request without confirmation.
- Collection import/export is planned, not in v0.1.2 — do not claim it exists.
