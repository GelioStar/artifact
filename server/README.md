Python FastAPI auth server for the Electron client.

To run:
  python3 -m pip install -r requirements.txt
  uvicorn server:app --host 127.0.0.1 --port 8000 --reload

The server stores data in app.db in this folder.
