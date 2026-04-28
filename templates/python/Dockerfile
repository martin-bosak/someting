FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements*.txt ./
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi
COPY . .
ARG BUILD_COMMAND=""
RUN if [ -n "$BUILD_COMMAND" ]; then sh -lc "$BUILD_COMMAND"; fi
ENV START_COMMAND="python -m gunicorn app:app --bind 0.0.0.0:8080"
EXPOSE 8080
CMD ["sh", "-lc", "$START_COMMAND"]
