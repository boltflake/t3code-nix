# The Home Manager module's server in a NixOS VM, with Home Manager as a
# NixOS module and no NixOS programs.t3code: a lingering user's
# t3code-server starts at boot and answers; an environmentFile under %h
# that sets T3CODE_HOME gets that home's database copied, not the unit's
# own home's; a switch to a different t3 keeps the running server
# (keep-old) until a restart, and so
# does a rollback (the changed generation also turns usage data back on, so
# the server keeps T3CODE_TELEMETRY_ENABLED=false until that restart);
# turning the server off stops its process, and on again starts a new one.
# Not among the flake's checks (it needs KVM); run it with
#
#   nix build .#legacyPackages.x86_64-linux.vmTests.homeManager -L
{
  pkgs,
  self,
  homeManager,
}:
pkgs.testers.runNixOSTest {
  name = "t3code-server-home-manager";
  nodes.machine =
    { lib, ... }:
    {
      imports = [ (homeManager + "/nixos") ];
      users.users.alice = {
        isNormalUser = true;
        linger = true;
      };
      home-manager = {
        useGlobalPkgs = true;
        useUserPackages = true;
        users.alice = {
          imports = [ self.homeModules.default ];
          home.stateVersion = "26.05";
          programs.t3code-nix.telemetry.enable = lib.mkDefault false;
          programs.t3code-nix.server = {
            enable = lib.mkDefault true;
            # The unit's own home, which the environmentFile's replaces.
            home = "%h/unit-home";
            # Optional: written after the first start.
            environmentFile = "-%h/t3.env";
          };
        };
      };
      environment.systemPackages = [
        pkgs.curl
        pkgs.sqlite
      ];
      virtualisation.memorySize = 2048;
      specialisation = {
        # Another t3 (fewer providers) and a marker in the unit's
        # environment.
        changed.configuration.home-manager.users.alice.programs.t3code-nix = {
          providers = [ "codex" ];
          server.logLevel = "Debug";
          telemetry.enable = true;
        };
        off.configuration.home-manager.users.alice.programs.t3code-nix.server.enable = false;
      };
    };
  testScript = ''
    def user(cmd):
        return machine.succeed(f"systemctl --user -M alice@ {cmd}").strip()

    def switch(to):
        machine.succeed(f"{to}/bin/switch-to-configuration test")
        machine.wait_for_unit("home-manager-alice.service")

    def serving():
        machine.wait_until_succeeds("curl -sf -o /dev/null http://127.0.0.1:3773/", timeout=120)

    # The running server: its PID, and which generation started it, from
    # its environment: the unit's marker (T3CODE_LOG_LEVEL), the package's
    # (claude-code on the PATH its t3 wrapper sets), and the
    # T3CODE_TELEMETRY_ENABLED its wrapper set, if any.
    def running_t3():
        pid = user("show -p MainPID --value t3code-server.service")
        env = machine.succeed(f"tr '\\0' '\\n' < /proc/{pid}/environ")
        path = next((l for l in env.splitlines() if l.startswith("PATH=")), "")
        tel = tuple(l for l in env.splitlines() if l.startswith("T3CODE_TELEMETRY_ENABLED="))
        return pid, ("T3CODE_LOG_LEVEL=Debug" in env, "claude-code" in path, tel)

    base = machine.succeed("readlink -f /run/current-system").strip()
    changed = base + "/specialisation/changed"
    off = base + "/specialisation/off"

    # Lingering: alice's manager starts at boot, and Home Manager's
    # activation (which may come after it) starts the unit it writes.
    machine.wait_for_unit("user@1000.service")
    machine.wait_for_unit("home-manager-alice.service")
    machine.wait_for_unit("t3code-server.service", "alice")
    serving()
    machine.succeed("test -L /home/alice/.config/systemd/user/t3code-server.service")
    machine.succeed("ss -ltn | grep -q '127.0.0.1:3773 '")

    # environmentFile under %h (systemd expands it) setting T3CODE_HOME, read
    # as it is and over the unit's own home: the copy before a new version is
    # of that home's database, not the unit home's (due a copy too).
    machine.succeed("test -f /home/alice/unit-home/userdata/statev2.sqlite")
    machine.succeed("su - alice -c 'echo 0.0.1 > /home/alice/unit-home/t3code-nix-backups/last-version'")
    machine.succeed("su - alice -c 'mkdir -p /home/alice/srv/userdata /home/alice/srv/t3code-nix-backups'")
    machine.succeed("su - alice -c \"sqlite3 /home/alice/srv/userdata/statev2.sqlite 'create table t (x); insert into t values (7);'\"")
    machine.succeed("su - alice -c 'echo 0.0.1 > /home/alice/srv/t3code-nix-backups/last-version'")
    machine.succeed("su - alice -c 'echo T3CODE_HOME=/home/alice/srv > /home/alice/t3.env'")
    user("restart t3code-server.service")
    machine.succeed("sqlite3 /home/alice/srv/t3code-nix-backups/statev2-0.0.1-*.sqlite 'select x from t' | grep -qx 7")
    machine.fail("ls /home/alice/unit-home/t3code-nix-backups/statev2-0.0.1-*.sqlite")
    serving()
    machine.succeed("rm /home/alice/t3.env")
    user("restart t3code-server.service")
    serving()

    # A switch to another t3 keeps the running server; a restart runs the
    # new one. A rollback, the same way back.
    pid, before = running_t3()
    assert before == (False, True, ("T3CODE_TELEMETRY_ENABLED=false",)), before
    switch(changed)
    assert running_t3() == (pid, before), "the switch restarted the server"
    user("restart t3code-server.service")
    # Answering: its t3 wrapper has set the PATH it reads.
    serving()
    _, after = running_t3()
    assert after == (True, False, ()), f"the restart didn't run the new generation's t3: {after}"
    serving()
    pid, _ = running_t3()
    switch(base)
    assert running_t3() == (pid, after), "the rollback restarted the server"
    user("restart t3code-server.service")
    serving()
    assert running_t3()[1] == before, "the restart didn't run the old t3"

    # Off: the switch stops it and removes the unit; on: the switch starts it.
    pid, _ = running_t3()
    switch(off)
    machine.wait_until_fails("curl -sf -o /dev/null http://127.0.0.1:3773/", timeout=60)
    # Its process is gone, not only its answers.
    machine.wait_until_fails(f"kill -0 {pid}", timeout=60)
    machine.fail("test -e /home/alice/.config/systemd/user/t3code-server.service")
    switch(base)
    machine.wait_for_unit("t3code-server.service", "alice")
    serving()
    assert running_t3()[0] != pid, "the switch back didn't start the server again"
  '';
}
