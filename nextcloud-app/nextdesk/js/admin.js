document.addEventListener('DOMContentLoaded', function () {
	var form = document.getElementById('nextdesk-admin-form')
	var msg = document.getElementById('nextdesk-admin-msg')
	if (!form) {
		return
	}

	form.addEventListener('submit', function (e) {
		e.preventDefault()
		var url = document.getElementById('nextdesk-url').value

		fetch(OC.generateUrl('/apps/nextdesk/settings/save'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				requesttoken: OC.requestToken,
			},
			body: JSON.stringify({ url: url }),
		})
			.then(function (r) {
				return r.json().then(function (data) {
					return { ok: r.ok, data: data }
				})
			})
			.then(function (result) {
				msg.textContent = result.ok ? t('nextdesk', 'Saved') : (result.data.error || t('nextdesk', 'Failed'))
				msg.style.color = result.ok ? 'var(--color-success)' : 'var(--color-error)'
			})
			.catch(function () {
				msg.textContent = t('nextdesk', 'Failed')
				msg.style.color = 'var(--color-error)'
			})
	})
})
