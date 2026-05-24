FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY left_hand_bot ./left_hand_bot

RUN useradd --create-home --shell /usr/sbin/nologin left-hand
USER left-hand

CMD ["python", "-m", "left_hand_bot"]

