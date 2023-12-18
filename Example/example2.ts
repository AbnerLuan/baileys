import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

// Mapa externo para armazenar contagens de tentativas de mensagens quando falha a criptografia/descriptografia
const msgRetryCounterCache = new NodeCache()

// Interface de linha de leitura
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// A 'store' mantém os dados da conexão WA na memória
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// Salva a cada 10 segundos
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// Inicia uma conexão
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// Busca a versão mais recente do WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`usando WA v${version.join('.')}, é a mais recente: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		auth: {
			creds: state.creds,
			// Usar cache acelera a loja para enviar/receber mensagens
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// Para ignorar todas as mensagens de transmissão, comente a linha abaixo
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		getMessage,
	})

	store?.bind(sock.ev)

	// Código de emparelhamento para clientes Web
	if(usePairingCode && !sock.authState.creds.registered) {
		if(useMobile) {
			throw new Error('Não é possível usar o código de emparelhamento com a API móvel')
		}

		const phoneNumber = await question('Por favor, insira seu número de telefone móvel:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Código de emparelhamento: ${code}`)
	}

	// Se a opção móvel foi escolhida, pede o código
	if(useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if(!registration.phoneNumber) {
			registration.phoneNumber = await question('Por favor, insira seu número de telefone móvel:\n')
		}

		const libPhonenumber = await import("libphonenumber-js")
		const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
		if(!phoneNumber?.isValid()) {
			throw new Error('Número de telefone inválido: ' + registration!.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if(!mcc) {
			throw new Error('Não foi possível encontrar MCC para o número de telefone: ' + registration!.phoneNumber + '\nPor favor, especifique o MCC manualmente.')
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Por favor, insira o código de uma vez:\n')
				const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
				console.log('Número de telefone registrado com sucesso.')
				console.log(response)
				rl.close()
			} catch(error) {
				console.error('Falha ao registrar seu número de telefone. Por favor, tente novamente.\n', error)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

			open(path)
			const code = await question('Por favor, insira o código do captcha:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if (!registration.method) {
				let code = await question('Como você gostaria de receber o código de uma vez para registro? "sms" ou "voz"\n')
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if(code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch(error) {
				console.error('Falha ao solicitar código de registro. Por favor, tente novamente.\n', error)

				if(error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// A função process permite processar todos os eventos que acabaram de ocorrer
    sock.ev.process(
        async(events) => {
            // algo sobre a conexão mudou
            if(events['connection.update']) {
                const update = events['connection.update']
                const { connection, lastDisconnect } = update
                if(connection === 'close') {
                    // reconectar se não estiver deslogado
                    if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
                        startSock()
                    } else {
                        console.log('Conexão fechada. Você foi deslogado.')
                    }
                }
    
                console.log('atualização de conexão', update)
            }
    
            // credenciais atualizadas -- salve-as
            if(events['creds.update']) {
                await saveCreds()
            }
    
            // outros eventos...
            // ... código omitido para simplificação ...
    
            // Removido 'return sock' para compatibilidade com a assinatura esperada da função
        }
    )
    

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if(store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// apenas se a loja estiver presente
		return proto.Message.fromObject({})
	}
}

startSock()
