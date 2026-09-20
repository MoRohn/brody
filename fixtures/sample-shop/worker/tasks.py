"""Background worker that emails receipts for paid orders."""
import os
import smtplib

from celery import Celery

app = Celery("shop", broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"))


@app.task
def send_receipt(order_id):
    """Look up the order in the receipt queue and send the receipt email."""
    try:
        body = f"Thanks for your order {order_id}"
        with smtplib.SMTP(os.environ["SMTP_HOST"]) as smtp:
            smtp.sendmail("shop@example.com", "customer@example.com", body)
    except:
        pass
