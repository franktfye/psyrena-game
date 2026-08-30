/**
 * Wardrobe state — the player's equipped skin and pet.
 *
 * Same module-singleton discipline as state/player.ts: the gear/skin/pet
 * panels and (later) the hero renderer all read it, and none of them should
 * own it. Persisted to localStorage so a reload keeps the look; this is a
 * client-side scaffold — the loadout is SERVER-OWNED later (account API,
 * docs/06), at which point this store becomes the local cache the server
 * snapshot writes into, exactly like the player store's HP/mana plan.
 */

const STORAGE_KEY = "psyrena_wardrobe";

interface WardrobeSave {
  skin: string;
  pet: string | null;
  /** See `petChosen` — absent in saves written before pets had a default. */
  petChosen?: boolean;
}

class WardrobeStore {
  skin = "default";
  pet: string | null = null;
  /**
   * Has the player ever touched the pet loadout?
   *
   * `pet === null` alone cannot answer that: it is both "never chose" and
   * "deliberately unequipped", and those want opposite behaviour in the world
   * — the first should get the hero's own pet walking beside them without
   * being asked, the second must stay empty. This flag splits them, so the
   * default is a genuine first-run default and Unequip is absolute.
   */
  petChosen = false;

  /**
   * Account-scoped storage key, set by `bindAccount` after login. Before it,
   * reads and writes go to the legacy shared key — which is exactly the bug
   * being fixed: one device-global wardrobe meant logging into a second
   * account inherited the first account's skin and pet.
   */
  private storageKey = STORAGE_KEY;

  private readonly listeners = new Set<() => void>();

  constructor() {
    this.load(STORAGE_KEY);
  }

  /**
   * Rescope the wardrobe to the logged-in account.
   *
   * First login after this shipped adopts the legacy shared save (the only
   * player who could have written it on this device is *a* player, and the
   * common case is one account per browser) and deletes it, so a later second
   * account starts from defaults instead of someone else's loadout.
   */
  bindAccount(username: string): void {
    this.storageKey = `${STORAGE_KEY}:${username.toLowerCase()}`;
    this.skin = "default";
    this.pet = null;
    this.petChosen = false;
    if (!this.load(this.storageKey) && typeof localStorage !== "undefined") {
      try {
        if (this.load(STORAGE_KEY)) {
          localStorage.removeItem(STORAGE_KEY);
          this.emit(); // migrate the adopted save onto the account key
          return;
        }
      } catch {
        // Privacy mode — in-memory defaults are fine.
      }
    }
    for (const cb of this.listeners) cb();
  }

  /** Read a save into the store. True when one existed and parsed. */
  private load(key: string): boolean {
    if (typeof localStorage === "undefined") return false;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const save = JSON.parse(raw) as Partial<WardrobeSave>;
      if (typeof save.skin === "string") this.skin = save.skin;
      if (typeof save.pet === "string" || save.pet === null) this.pet = save.pet;
      // A save written before this flag existed came from a player who DID
      // use the panel (that is the only thing that writes one), so treat it
      // as chosen rather than re-defaulting a pet they may have removed.
      this.petChosen = save.petChosen ?? true;
      return true;
    } catch {
      // A corrupt or unreadable save is not worth a broken boot — defaults win.
      return false;
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setSkin(skin: string): void {
    this.skin = skin;
    this.emit();
  }

  setPet(pet: string | null): void {
    this.pet = pet;
    this.petChosen = true;
    this.emit();
  }

  private emit(): void {
    if (typeof localStorage !== "undefined") {
      try {
        const save: WardrobeSave = { skin: this.skin, pet: this.pet, petChosen: this.petChosen };
        localStorage.setItem(this.storageKey, JSON.stringify(save));
      } catch {
        // Quota/privacy-mode failures must not break equipping in-session.
      }
    }
    for (const cb of this.listeners) cb();
  }
}

export const wardrobe = new WardrobeStore();
