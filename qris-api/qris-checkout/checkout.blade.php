<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pembayaran {{ $trx->reference_id }} - Vipkode</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.0.1/css/all.min.css" integrity="sha512-2SwdPD6INVrV/lHTZbO2nodKhrnDdJK9/kg2XD1r9uGqPo1cUbujc+IYdlYdEErWNu69gVcYgdxlmVmzTWnetw==" crossorigin="anonymous" referrerpolicy="no-referrer" />
    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
    <style>
        /*body { background-color: #f4f6f8; }*/
        .checkout-card { max-width: 480px; margin: 30px auto; border-radius: 15px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: none; }
        .qr-container { background: #fff; padding: 20px; border-radius: 10px; border: 2px dashed #e0e0e0; display: inline-block; }
        .status-badge { font-size: 0.9rem; padding: 8px 15px; border-radius: 50px; }
        
*,
*::before,
*::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: sans-serif;
}

.container {
  width: min(95%, 425px);
  margin: 1em auto;
}

/* ---- invoice ---- */
.invoice-container {
  position: relative;
  margin-bottom: 2em;
  height: 630px;
}

.invoice-slot {
  width: 100%;
  height: 120px;
  background-color: #2b2b2b;
  border: 2px solid #2c2c2c;
  border-radius: 1em;
  box-shadow: 0 0 1px 0 #000, 0 5px 15px 0 rgba(0, 0, 0, 0.45);
}

.slot-hole {
  background-color: #000;
  border-radius: 100vmax;
  width: 90%;
  height: 25px;
  margin: 1em auto;
  border: 1px solid #1b1b1b;
  box-shadow: 0 0 1px 0 #000, 0 5px 15px 0 rgba(0, 0, 0, 0.45);
}

.invoice {
  position: absolute;
  width: 85%;
  top: 1.5em;
  left: 50%;
  transform: translateX(-50%);
  background-color: #fff;
  color: #6b7280;
  padding: 1em;
  border-radius: 0.5em;
  box-shadow: 0 5px 25px 0 rgba(0, 0, 0, 0.15);
}

.invoice::before {
  content: "";
  position: absolute;
  width: 100%;
  height: 80px;
  left: 0;
  top: 0;
  background: linear-gradient(
    180deg,
    rgba(0, 0, 0, 0.95) 0%,
    rgba(0, 0, 0, 0.75) 10%,
    rgba(0, 0, 0, 0.65) 25%,
    rgba(0, 0, 0, 0.45) 40%,
    rgba(0, 0, 0, 0.25) 60%,
    transparent 100%
  );
}

.invoice img {
  width:100%;

}

.invoice .title {
  position: relative;
  font-size: 1.15rem;
  padding: 0.55em 0;
  letter-spacing: 0.5px;
  text-align: center;
  margin-bottom: 1.25em;
  font-weight: 500;
  color: #1b1b1b;
}

.invoice .title::before {
  content: "";
  position: absolute;
  height: 1.5px;
  width: 100%;
  top: 0;
  left: 0;
  background-image: repeating-linear-gradient(
    90deg,
    #1b1b1b,
    #1b1b1b 8px,
    transparent 8px,
    transparent 16px
  );
}

.invoice .title::after {
  content: "";
  position: absolute;
  height: 1.5px;
  width: 100%;
  bottom: 0;
  left: 0;
  background-image: repeating-linear-gradient(
    90deg,
    #1b1b1b,
    #1b1b1b 8px,
    transparent 8px,
    transparent 16px
  );
}

.invoice .amount,
.invoice .payment-status .heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 1rem;
  margin-bottom: 0.5em;
}

.invoice .amount .value {
  font-weight: 700;
  color: #000;
}

.invoice .payment-status {
  border: 1px solid #ddd;
  padding: 1em;
  border-radius: 15px;
  margin-top: 1em;
}

.invoice .payment-status .heading span {
  text-transform: uppercase;
  font-weight: 500;
  color: #000;
}

.payers-list {
  list-style-type: none;
  margin: 0.5em 0;
}

.payers-list li {
  border-bottom: 1px solid #eee;
  display: flex;
  align-items: center;
}

.payers-list li p {
  flex-grow: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.9rem;
  padding: 0.5em;
}

.payers-list .payer-image-container {
  padding: 0.5em;
  border-right: 1px solid #eee;
}

.payers-list .payer-image-container img {
  width: 35px;
  border-radius: 50%;
}

.payers-list .pay-tag {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 0.3em 0.5em;
}

.fa-circle-check {
  color: #22c55e;
}

.fa-clock {
  color: #d97706;
}

.btn-group {
  display: flex;
  align-items: content;
  gap: 0.75em;
  margin-top: 1.25em;
}

.status-progress {
  position: relative;
  margin: 1.5em 0 0.5em 0;
  height: 6px;
  background-image: linear-gradient(90deg, #000 75%, #eee 75%);
}

.checkpoint {
  position: absolute;
  background: rgba(255, 255, 255, 0.95);
  border: 2px solid red;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 0.5px solid #eee;
  display: flex;
  justify-content: center;
  align-items: center;
  box-shadow: 0 5px 10px 0 rgba(0, 0, 0, 0.15);
}

.checkpoint .circle {
  display: inline-block;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background-color: #000;
}

.checkpoint:nth-child(1) {
  left: 0;
  top: 0;
  transform: translate(-5%, -40%);
}

.checkpoint:nth-child(2) {
  left: 25%;
  top: 0;
  transform: translate(-25%, -40%);
}

.checkpoint:nth-child(3) {
  left: 50%;
  top: 0;
  transform: translate(-50%, -40%);
}

.checkpoint:nth-child(4) {
  left: 75%;
  top: 0;
  transform: translate(-75%, -40%);
}

.checkpoint:nth-child(5) {
  right: 0;
  top: 0;
  transform: translate(5%, -40%);
}

.fa-stamp {
  color: #000;
}

.btn {
  flex-grow: 1;
  border-radius: 100vmax;
  padding: 0.5em 0;
  font-size: 0.85rem;
  box-shadow: 0 5px 10px 0 rgba(0, 0, 0, 0.15);
  cursor: pointer;
}

.reminder-btn {
  color: #fff;
  background-color: #111827;
  border: 1px solid #1b1b1b;
}

.download-btn {
  border: 1px solid #eee;
  background-color: #fff;
}

/* ----------- */

hr {
  border: none;
  height: 1px;
  background-color: #ddd;
  margin: 0.75em 0;
}

/* payment info */

.payment-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0.75em 1em;
  font-size: 1rem;
  color: #6b7280;
}

.card-info {
  display: flex;
  align-items: center;
  gap: 0.75em;
}

.card-icon {
  display: inline-block;
  width: 35px;
  height: 26px;
  background-color: #1a43bf;
  border-radius: 5px;
}

.pay-now-btn {
  font-size: 1.15rem;
  background-color: #111827;
  color: #fff;
  width: 100%;
  background-color: #111827;
  color: #fff;
  width: 100%;
  padding: 0.75em 0;
  border: 2px solid #1b1b1b;
  border-radius: 0.75em;
  box-shadow: 0 0 1px 0 #000, 0 5px 15px 0 rgba(0, 0, 0, 0.45);
  cursor: pointer;
}

@media (max-width: 424px) {
  h1 {
    font-size: 1.2rem;
  }

  .invoice {
    padding: 0.75em;
  }

  .invoice .title {
    position: relative;
    font-size: 1rem;
    padding: 0.5em 0;
  }

  .slot-hole {
    width: 95%;
  }
  .invoice {
    width: 90%;
  }

  .invoice .amount {
    font-size: 0.85rem;
  }

  .payers-list li p {
    font-size: 0.85rem;
  }

  .payers-list .pay-tag {
    font-size: 0.8rem;
  }

  .btn {
    padding: 0.5em 0;
    font-size: 0.8rem;
  }

  .payment-info {
    font-size: 0.95rem;
  }

  .pay-now-btn {
    font-size: 1.05rem;
  }
}
</style>
</head>

<body>
    <section class="container">
        <section class="invoice-container">
            <div class="invoice-slot">
                <div class="slot-hole"></div>
            </div>
            <div class="invoice">
                <h2 class="title">Scan Qris</h2>
                <!--<img src="{{ $qris }}"></img>-->
                <div id="qr-wrapper" style="position: relative; max-width: 320px; margin: 0 auto;">
                    <!-- Background Frame (GoPay) -->
                    <img src="/images/qris.webp" style="width: 100%; display: block; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" alt="QRIS Frame">
                    
                    <!-- Dynamic QR Code overlay (Menimpa QR bawaan frame) -->
                    <div style="position: absolute;top: 26%;left: 15%;width: 70%;height: 50%;background: #ffffff;display: flex;align-items: center;justify-content: center;border-radius: 5px;">
                        <img src="{{ '/api/v1/qr-render?code=' . urlencode($trx->qr_string) }}" style="width: 95%; height: 95%; object-fit: contain;" alt="Dynamic QR">
                    </div>
                </div>
                <hr />
                <div class="payment-status">
                    <p class="heading">Payment Status <span id="status-badge" style="color: #d97706;">PENDING</span></p>
                    <p class="heading" style="margin-top: 8px; font-size: 0.95rem;">Sisa Waktu <span id="countdown" style="color: #ef4444; font-weight: bold; font-variant-numeric: tabular-nums;">--:--</span></p>
                </div>
                <div class="btn-group">
                    <button class="btn reminder-btn" onclick="location.reload()">Check Status</button>
                    <a href="{{ '/api/v1/qr-render?code=' . urlencode($trx->qr_string) }}" download="QRIS-{{ $trx->reference_id }}.png" class="btn download-btn" style="text-align: center; text-decoration: none; line-height: 2.2;">Download QRIS</a>
                </div>
            </div>
        </section>
        <hr />
        <!--<div class="payment-info">-->
        <!--    <p>Payment Method</p>-->
        <!--    <div class="card-info">-->
        <!--        <p>QRIS (All E-Wallet & Bank)</p>-->
        <!--        <span class="card-icon" style="background-color: transparent;"><img src="https://cdn-icons-png.flaticon.com/512/190/190411.png" style="width: 25px;"></span>-->
        <!--    </div>-->
        <!--</div>-->
        @if($trx->return_url)
            <!--<button class="pay-now-btn">Back</button>-->
        @endif
        
    </section>
<script type="module">
    const socket = io('/', { path: '/socket.io', transports: ['websocket'] });
    const trxRef = "{{ $trx->reference_id }}";
    const roomName = 'transaction.' + trxRef;
    const returnUrl = @json($trx->return_url);
    const expiredAt = {{ \Carbon\Carbon::parse($trx->expired_at)->timestamp * 1000 }};
    let isFinalized = false;
    
    const timerInterval = setInterval(function() {
        if (isFinalized) {
            clearInterval(timerInterval);
            return;
        }
        
        const now = new Date().getTime();
        const distance = expiredAt - now;

        if (distance < 0) {
            clearInterval(timerInterval);
            document.getElementById('countdown').innerHTML = "00:00";
            handleStatusUpdate('EXPIRED');
            return;
        }

        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);

        document.getElementById('countdown').innerHTML = 
            (minutes < 10 ? "0" + minutes : minutes) + ":" + 
            (seconds < 10 ? "0" + seconds : seconds);
    }, 1000);

    socket.on('connect', () => {
        socket.emit('join', roomName);
    });

    socket.on('TransactionStatus', (data) => {
        handleStatusUpdate(data.status);
    });

    // Fallback Polling: Handle mobile browser suspending websockets
    setInterval(() => {
        if(isFinalized) return;
        fetch('/check-status/' + trxRef)
            .then(response => response.json())
            .then(data => {
                if(data && data.status && data.status !== 'PENDING') {
                    handleStatusUpdate(data.status);
                }
            }).catch(err => console.error("Polling error", err));
    }, 5000);

    function handleStatusUpdate(status) {
        if (isFinalized) return;

        if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'PAID') {
            isFinalized = true;
            document.getElementById('status-badge').innerHTML = 'SUCCESS';
            document.getElementById('status-badge').style.color = '#22c55e';
            document.getElementById('countdown').innerHTML = 'PAID';
            document.getElementById('countdown').style.color = '#22c55e';
            
            document.getElementById('qr-wrapper').innerHTML = '<img src="/images/paysuccess.webp" style="width: 50%; margin: 2rem auto; display: block;" alt="Success">';
            
            setTimeout(() => {
                if (returnUrl) {
                    const separator = returnUrl.includes('?') ? '&' : '?';
                    window.location.href = `${returnUrl}${separator}reference=${trxRef}&merchant_ref={{ $trx->merchant_ref }}&status=SUCCESS`;
                } else {
                    location.reload(); 
                }
            }, 3000);
            
        } else if (status === 'EXPIRED') {
            isFinalized = true;
            document.getElementById('status-badge').innerHTML = 'EXPIRED';
            document.getElementById('status-badge').style.color = '#ef4444';
            document.getElementById('countdown').innerHTML = '00:00';
            
            document.getElementById('qr-wrapper').innerHTML = '<img src="/images/expired.webp" style="width: 50%; margin: 2rem auto; display: block;" alt="Expired">';
        }
    }
</script>

</body>
</html>