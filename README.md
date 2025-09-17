# AI Google Answer

Small Node.js app that searches Google using the Custom Search API, fetches the top page, extracts text, and returns an AI-style answer. Optionally uses OpenAI to synthesize a concise answer.

Environment variables (create a .env file):

- GOOGLE_API_KEY - your Google Cloud API key with Custom Search enabled
- GOOGLE_CX - your Custom Search Engine ID
- OPENAI_API_KEY - (optional) OpenAI API key to refine answers

Quick start (PowerShell):

```powershell
cd c:\Users\anton\OneDrive\Desktop\ai
npm install
copy .env.example .env
# edit .env with your keys
npm start
```

Open http://localhost:3000
