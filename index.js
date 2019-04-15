const needle = require('needle')
const async = require('async')
const { config, persist } = require('internal')


let categories = []
const catalogs = []
const channels = {}
const channelMap = {}
const metas = {}
const token = btoa(JSON.stringify({ username: config.username, password: config.password }))

let loginExpire = 0

const endpoint = config.host || 'http://vapi.vaders.tv/'


function btoa(str) {
	var buffer;

	if (str instanceof Buffer) {
		buffer = str
	} else {
		buffer = Buffer.from(str.toString(), 'binary')
	}

	return buffer.toString('base64');
}

function getTimestamp() { return Math.floor(Date.now() / 1000) }

function expired(cb) { cb(!(loginExpire > getTimestamp())) }

function isLogedIn(cb) {
	expired(isExpired => {
		if (isExpired) {
			needle.get(endpoint + 'users/me?token=' + token, (err, resp, body) => {
				if (body && body.message) {
					console.log(body.message)
					cb()
				} else if (err) {
					console.log(err && err.message ? err.message : 'Unknown error occurred.')
					cb()
				} else {
					// login success
					categories = body.categories
					persist.setItem('categories', body.categories)
					cb(body.categories)
				}
			})
		} else
			cb(categories || [])
	})
}

function request(url, cb) {
	isLogedIn(() => { needle.get(url, cb) })
}

function retrieveManifest() {
	function manifest() {
		return {
			id: 'org.vaderstv',
			version: '1.0.1',
			name: 'Vader Streams IPTV',
			description: 'IPTV Service - Requires Subscription',
			resources: ['stream', 'meta', 'catalog'],
			types: ['tv'],
			idPrefixes: ['vaders_'],
			icon: 'https://res.cloudinary.com/teepublic/image/private/s--LVDsoQK4--/t_Preview/b_rgb:191919,c_limit,f_jpg,h_630,q_90,w_630/v1475223127/production/designs/707738_1.jpg',
			catalogs
		}
	}

	return new Promise((resolve, reject) => {
		isLogedIn(cats => {
			if (cats && cats.length) {
				if (catalogs) {
					resolve(manifest())
				} else {
					const qu = async.queue((cat, cb) => {
						if (cat && cat.id && cat.id > 1) {
							request(endpoint + 'epg/channels?token=' + token + '&category_id=' + cat.id, (err, resp, body) => {
								if (body && Array.isArray(body) && body.length) {
									channels[cat.name] = body.map(toMeta)
									catalogs.push({
										type: 'tv',
										id: cat.name,
										name: cat.name,
										extraSupported: ['search']
									})
									cb()
								} else {
									// ignore channel errors for now
									cb()
								}
							})
						} else
							cb()
					}, 1)
					qu.drain = () => {
						persist.setItem('catalogs', catalogs)
						resolve(manifest())
					}
					categories.forEach(cat => { qu.push(cat) })
				}
			} else {
				console.log('No stream categories available')
				resolve(manifest())
			}
		})
	})
}

async function retrieveRouter() {

	const manifest = await retrieveManifest()

	const { addonBuilder, getInterface, getRouter } = require('stremio-addon-sdk')

	const builder = new addonBuilder(manifest)

	builder.defineCatalogHandler(args => {
		if (!catalogs.length && persist.getItem('catalogs').length)
			catalogs = persist.getItem('catalogs')
		return new Promise((resolve, reject) => {
			if (args.type == 'tv' && args.id) {
				if (args.extra && args.extra.search) {
					const results = []
					channels[args.id].forEach(chan => {
						if (chan.name.toLowerCase().includes(args.extra.search.toLowerCase()))
							results.push(chan)
					})

					resolve(results.length ? { metas: results } : null)
				} else
					resolve(channels[args.id] ? { metas: channels[args.id] } : null)
			} else
				reject('Vaders - Unknown catalog request')
		})
	})

	builder.defineMetaHandler(args => {
		return new Promise((resolve, reject) => {
			if (args.id) {
				const startTS = new Date(Date.now()).toISOString().split('.')[0].replace(/[^0-9.]/g, "")
				const stopTS = new Date(Date.now() + 10800000).toISOString().split('.')[0].replace(/[^0-9.]/g, "")
				const channelId = args.id.split('_')[1]
				if (channelId)
					request(endpoint + 'epg/channels/'+channelId+'?token='+token+'&start='+startTS+'&stop='+stopTS, (err, resp, body) => {
						if (body) {
							if (body[0] && body[0].id)
								resolve({ meta: toMeta(body[0]) })
							else if (body.id)
								resolve({ meta: toMeta(body) })
							else
								resolve()
						} else
							resolve()
					})
				else {

					let meta

					for (let key in channels) {
						if (!meta)
							channels[key].some(chan => {
								if (chan.id == args.id) {
									meta = chan
									return true
								}
							})
					}

					resolve(meta ? { meta } : null)

				}
			} else
				reject('Vaders - Unknown meta request')
		})
	})

	builder.defineStreamHandler(args => {
		return new Promise((resolve, reject) => {
			if (args.id) {
				let streamId = args.id.split('_')
				streamId = streamId[streamId.length-1]
				resolve({ streams: [{ title: 'Play Now', url: endpoint + 'play/' + streamId + '.m3u8?token=' + token }] })
			} else
				reject('Vaders - Unknown stream request')
		})
	})

	const addonInterface = getInterface(builder)

	return getRouter(addonInterface)

}

module.exports = retrieveRouter()
