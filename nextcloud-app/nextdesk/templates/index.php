<?php
/** @var array $_ */
/** @var \OCP\IL10N $l */
style('nextdesk', 'style');
?>
<div id="nextdesk-embed">
    <?php if (empty($_['url'])): ?>
        <div class="nextdesk-empty">
            <img src="<?php p($_['logoUrl']); ?>" alt="" class="nextdesk-empty-logo" />
            <p><?php p($l->t('Nextdesk is not configured yet.')); ?></p>
            <p><?php p($l->t('An administrator needs to set the Nextdesk URL in Settings → Administration → Nextdesk.')); ?></p>
        </div>
    <?php else: ?>
        <iframe
            src="<?php print_unescaped(\OCP\Util::sanitizeHTML($_['url'])); ?>"
            title="Nextdesk"
            allow="clipboard-read; clipboard-write; fullscreen; autoplay"
            allowfullscreen
        ></iframe>
    <?php endif; ?>
</div>
