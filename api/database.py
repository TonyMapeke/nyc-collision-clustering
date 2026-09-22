import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine

# uvicorn doesn't always run from the project root, so point at .env directly
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

DB_USER = os.environ.get("BRONX_DB_USER", "postgres")
DB_PASSWORD = os.environ["BRONX_DB_PASSWORD"]
DB_HOST = os.environ.get("BRONX_DB_HOST", "localhost")
DB_PORT = os.environ.get("BRONX_DB_PORT", "5432")
DB_NAME = os.environ.get("BRONX_DB_NAME", "bronx_collisions")

engine = create_engine(
    f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}",
    pool_pre_ping=True,  # drop dead connections instead of erroring on the next request
)