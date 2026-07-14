# Asistente personal por WhatsApp

## Qué hace
- Recibe tus mensajes de WhatsApp y los clasifica automáticamente en: ideas, recordatorios, reuniones, llamadas, reparaciones urgentes, reparaciones generales, vehículo.
- Te manda un resumen de pendientes todas las mañanas (8:00) y en la tarde (15:30).
- Comandos que puedes escribir por WhatsApp:
  - `lista` → ver todos los pendientes
  - `lista ideas` → ver solo una carpeta (ideas, recordatorios, reuniones, llamadas, reparaciones_urgentes, reparaciones_generales, vehiculo)
  - `hecho 5` → marcar el item #5 como completado
  - cualquier otro texto → se guarda clasificado automáticamente

## Pasos para dejarlo funcionando

### 1. Consigue tu API Key de Anthropic
Ve a console.anthropic.com → API Keys → Create Key. Cópiala.

### 2. Completa el archivo .env
Copia `.env.example` a `.env` y llena:
- `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN`: los que ya tienes en tu Twilio Console
- `TWILIO_WHATSAPP_FROM`: el número Sandbox (whatsapp:+14155238886)
- `MI_WHATSAPP`: tu número en formato whatsapp:+56XXXXXXXXX
- `ANTHROPIC_API_KEY`: la que sacaste en el paso 1

### 3. Prueba localmente (opcional)
```
npm install
node index.js
```

### 4. Despliega en Railway (gratis para empezar)
1. Crea cuenta en railway.app
2. New Project → Deploy from GitHub (sube este código a un repo) o usa Railway CLI
3. En Variables, pega el contenido de tu `.env`
4. Railway te da una URL pública, ej: https://tu-app.up.railway.app

### 5. Conecta el webhook en Twilio
1. Twilio Console → Messaging → Try it out → Send a WhatsApp message
2. En "Sandbox Settings", en el campo "When a message comes in", pon:
   `https://tu-app.up.railway.app/whatsapp`
3. Método: HTTP POST
4. Guarda

### 6. ¡Listo!
Escríbete a ti mismo por WhatsApp al número Sandbox y prueba.

## Nota sobre el Sandbox
El Sandbox de Twilio se desconecta tras 3 días sin uso — reenvías el `join <código>` y sigue funcionando. Si más adelante quieres que sea permanente sin reconectar, se puede registrar un número propio de WhatsApp Business (proceso de verificación con Meta).
