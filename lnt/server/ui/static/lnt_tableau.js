/*jslint browser: true, devel: true*/
/*global $, jQuery, tableau, ts_url */

(function() {
  // Create the connector object.
  var myConnector = tableau.makeConnector();

  // TODO: make the server report types.
  // Map LNT types to Tableau datatypes.
  var col_type_mapper = {
    "compile_status": tableau.dataTypeEnum.int,
    "execution_status": tableau.dataTypeEnum.int,
    "compile_time": tableau.dataTypeEnum.float,
    "execution_time": tableau.dataTypeEnum.float,
    "score": tableau.dataTypeEnum.int,
    "mem_bytes": tableau.dataTypeEnum.int,
    "hash_status": tableau.dataTypeEnum.int,
    "hash": tableau.dataTypeEnum.string,
    "code_size": tableau.dataTypeEnum.int};

  /** Get a json payload from the LNT server asynchronously or error.
   * @param {string} payload_url JSON payloads URL.
   */
  function getValue(payload_url) {
    var response = $.ajax({
      url: payload_url,
      async: false,
      cache: false,
      timeout: 60000, // Make all requests timeout after a minute.
    });

    if (response.status >= 400) {
      var error_msg = "Requesting data from LNT failed with:\n\n HTTP " +
        response.status + ": " + response.responseText + "\n\nURL: " +
        payload_url
      tableau.abortWithError(error_msg);
      throw new Error(error_msg);
    }

    return JSON.parse(response.responseText);
  }

  function get_matching_machines(regexp) {
    const name_regexp = new RegExp(regexp);
    var resp = getValue(ts_url + "/machines/");
    var machines = resp.machines;
    return machines.filter(function (name_ids) {
      return name_regexp.test(name_ids.name);
    });
  }

  // Define the schema.
  myConnector.getSchema = function (schemaCallback) {
    var search_info = JSON.parse(tableau.connectionData);
    tableau.reportProgress("Getting Schema from LNT.");

    // Lookup machines of interest, and gather run fields.
    var machine_names = get_matching_machines(search_info.machine_regexp);
    if (machine_names.length === 0) {
      tableau.abortWithError("Did not match any machine names matching: " +
          search_info.machine_regexp);
    }

    var field_info = getValue(ts_url + "/fields/");

    var fields = field_info.fields;
    var sample_cols = [];
    var run_cols = [];

    run_cols.push({
        id: "machine_name",
        alias: "Machine Name",
        dataType: tableau.dataTypeEnum.string
    });

    run_cols.push({
      id: "run_id",
      alias: "Run ID",
      dataType: tableau.dataTypeEnum.int
    });
    sample_cols.push({
      id: "run_id",
      alias: "Run ID",
      dataType: tableau.dataTypeEnum.int,
      filterable: true,
      foreignKey: {
        "tableId": "measurement_data",
        "columnId": "run_id"
      }
    });
    run_cols.push({
      id: "run_order",
      alias: "Run Order",
      dataType: tableau.dataTypeEnum.string
    });
    run_cols.push({
      id: "run_date",
      alias: "Run DateTime",
      dataType: tableau.dataTypeEnum.datetime
    });
    sample_cols.push({
      id: "test_name",
      alias: "Test",
      dataType: tableau.dataTypeEnum.string
    });

    fields.forEach(function(field) {
      sample_cols.push({
        id: field.column_name,
        alias: field.column_name,
        dataType: col_type_mapper[field.column_name]
      });
    });

      var measurementsSchema = {
        id: "measurement_data",
        alias: "Measurement Data",
        columns: sample_cols,
        incrementColumnId: "run_id",
        joinOnly: true
      };

      var runSchema = {
        id: "run_information",
        alias: "Run Information",
        columns: run_cols,
        incrementColumnId: "run_id"
      };

    var standardConnection = {
      "alias": "Measurements with Run Info",
      "tables": [{
        "id": "run_information",
        "alias": "Run Information"
      }, {
        "id": "measurement_data",
        "alias": "Measurements"
      }],
      "joins": [{
        "left": {
          "tableAlias": "Run Information",
          "columnId": "run_id"
        },
        "right": {
          "tableAlias": "Measurements",
          "columnId": "run_id"
        },
        "joinType": "inner"
      }]
    };
    //
    schemaCallback([runSchema, measurementsSchema],[standardConnection] );
  }


  // Download the data.
  myConnector.getData = function (table, doneCallback) {
    // How often (in terms of fetches) to report progress.
    var progress_batch_size = 100;
    var last_run_id = parseInt(table.incrementValue || 0);
    if (table.tableInfo.id === "run_information") {
      // Collect the Run Infos table.
      // Get latest machines.
      var search_info = JSON.parse(tableau.connectionData);
      var machine_names = get_matching_machines(search_info.machine_regexp);
      if (machine_names.length === 0) {
        tableau.abortWithError("Did not match any machine names matching: " +
            search_info.machine_regexp);
      } else {
         tableau.reportProgress("Found " + machine_names.length +
             " machines to fetch.");
      }

      // Get runs for each of the filtered machines in batches.
      var tableData = [];
      // It is faster to submit in batches.
      var submission_batch_size = 10000;
      var total_fetched = 1;
      machine_names.forEach(function (machine) {
        var machines_run_data = getValue(ts_url + "/machines/" + machine.id)

        machines_run_data.runs.forEach(function(run_info){
          // Incremental support.
          if (run_info.id <= last_run_id) {
              return;
          }

          var date_str = run_info.end_time;
          var run_date = new Date(date_str);
          tableData.push({run_id: run_info.id,
            machine_name: machines_run_data.machine.name,
            run_order: run_info[run_info.order_by],
            run_date: run_date});

          if (total_fetched % submission_batch_size == 0) {
            table.appendRows(tableData);
            tableData.length = 0;  // Drop the submitted rows.
          }
          total_fetched = total_fetched + 1;
        });
      });
      table.appendRows(tableData);
    } else if (table.tableInfo.id === "measurement_data") {
      // Collect Sample data.
      var filterValues = table.filterValues;

      if (!table.isJoinFiltered) {
        tableau.abortWithError("The table must be filtered first.");
        return;
      }

      if (filterValues.length === 0) {
        doneCallback();
        return;
      }

      var tableData = [];
      var total_fetched = 1;
      // Processing by batch is much faster; however, there is a
      // 128mb limit to the JS interpreter in Tableau.
      // This is a guess with some envelope math.
      var submission_batch_size = 10000;

      for (var i in filterValues) {

        var run_id = filterValues[i];
        if (run_id <= last_run_id) {
              return;
        }

        if (total_fetched % progress_batch_size == 1) {
          var next_run_max = total_fetched + progress_batch_size;
          var status_msg = "Getting Runs: " + run_id +
              " (" + total_fetched + "-" + next_run_max + " of " + filterValues.length + ").";
          tableau.reportProgress(status_msg);
        }

        run_data = getValue(ts_url + "/runs/" + run_id);

        run_data.tests.forEach(function (element) {
          element.test_name = element.name;
          delete element.name;
          tableData.push(element);

        });
        if (tableData.length > submission_batch_size) {
          table.appendRows(tableData);
          tableData.length = 0;  // Drop the submitted rows.
        }
        total_fetched = total_fetched + 1;
        run_data = null;
      }
      table.appendRows(tableData);
    } else {
      throw new Error("Unexpected table id " + table.tableInfo.id)
    }
    doneCallback();
  };

  tableau.registerConnector(myConnector);

  // Create event listeners for when the user submits the form.
  $(document)
    .ready(function () {
      $("#submitButton")
        .click(function () {
          var requested_machines = {
            machine_regexp: $("#machine-name")
              .val()
              .trim()
          };
          // This will be the data source name in Tableau.
          tableau.connectionName = requested_machines.machine_regexp + " (LNT)";
          tableau.connectionData = JSON.stringify(requested_machines);
          tableau.submit(); // This sends the connector object to Tableau
        });
    });
})();


