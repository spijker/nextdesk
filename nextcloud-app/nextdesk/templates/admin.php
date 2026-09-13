<?php
/** @var array $_ */
/** @var \OCP\IL10N $l */
script('nextdesk', 'admin');
style('nextdesk', 'style');
?>
<div id="nextdesk-admin" class="section">
    <h2>
        <img src="<?php p($_['logoUrl']); ?>" alt="" class="nextdesk-admin-logo" />
        <?php p($l->t('Nextdesk')); ?>
    </h2>
    <p class="settings-hint">
        <?php p($l->t('The URL of your Nextdesk instance, embedded in an iframe on the Nextdesk app page. Nextdesk must separately be configured to trust this Nextcloud as its OIDC provider, and its nginx must allow this Nextcloud\'s origin to frame it — see the Nextdesk app\'s README.')); ?>
    </p>
    <form id="nextdesk-admin-form">
        <label for="nextdesk-url"><?php p($l->t('Nextdesk URL')); ?></label><br/>
        <input
            type="url"
            id="nextdesk-url"
            name="url"
            placeholder="https://desk.example.com"
            value="<?php p($_['url']); ?>"
            style="width: 350px;"
        />
        <button type="submit"><?php p($l->t('Save')); ?></button>
        <span id="nextdesk-admin-msg"></span>
    </form>
</div>
